import Foundation

enum ModuleUpdatePolicy {
    static func shouldInstall(installed: String, available: String) -> Bool {
        compare(installed, available) < 0
    }

    private static func compare(_ left: String, _ right: String) -> Int {
        let lhs = left.split(separator: ".").map { Int($0) ?? 0 }
        let rhs = right.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(lhs.count, rhs.count, 3) {
            let a = index < lhs.count ? lhs[index] : 0
            let b = index < rhs.count ? rhs[index] : 0
            if a != b { return a < b ? -1 : 1 }
        }
        return 0
    }
}

private struct EmbeddedModuleUpdateInfo: Decodable {
    let version: String
}

enum ModuleSetupStage: Equatable {
    case idle
    case connecting
    case updating
    case initializing
    case checkingAudio
    case ready
    case failed(String)

    var title: String {
        switch self {
        case .idle: return "等待接入模块"
        case .connecting: return "正在连接模块"
        case .updating: return "正在更新模块"
        case .initializing: return "正在初始化通信"
        case .checkingAudio: return "正在检查通话音频"
        case .ready: return "模块已就绪"
        case let .failed(message): return message
        }
    }
}

/// 移动端 App 的主状态中心：前台轮询模块代理并驱动五个主要页面。
@MainActor
final class AppModel: ObservableObject {
    @Published var activeCall: CallRecord?
    @Published var callHistory: [CallRecord] = []
    @Published var messages: [SMSMessage] = []
    @Published var numberInput = ""
    @Published var isOnline = false
    @Published var connectionMessage: String?
    @Published var isBusy = false
    @Published var isMuted = false
    @Published var isSpeakerEnabled = false
    @Published var isRecording = false
    @Published var errorMessage: String?
    @Published var setupStage: ModuleSetupStage = .idle
    @Published private(set) var preparingModule = false
    @Published private(set) var modemStatus: ModemStatus?
    @Published private(set) var agentVersion: String?
    @Published private(set) var systemPower: SystemPowerStatus?

    let api: DJOneHubAPI
    let contacts = ContactStore()
    let audio = AudioSessionController()
    let callKit = CallKitController()
    let backgroundStandby = BackgroundStandbyController()
    let incomingNotifier = IncomingCallNotifier()
    let liveActivity = LiveActivityController()

    private let historyStore = LocalHistoryStore()

    private var pollingTask: Task<Void, Never>?
    private var callEventTask: Task<Void, Never>?
    private var mobileProfileTask: Task<Void, Never>?
    private var moduleUpdateTask: Task<Void, Never>?
    private var moduleMetadataTask: Task<Void, Never>?
    private var nextModuleUpdateAttempt = Date.distantPast
    private var startingCallAudio = false
    private var appIsActive = true
    private var pollingGeneration = 0
    private var hasStarted = false
    private var consecutivePollFailures = 0
    private var nextMessagesRefresh = Date.distantPast
    private var nextAudioDiagnosticRefresh = Date.distantPast
    private var nextModuleMetadataRefresh = Date.distantPast
    private var nextMobileProfileAttempt = Date.distantPast
    private var mobileProfileSwitching = false
    private var audioWarmupCallID: String?
    private var lowPowerModeEnabled = true
    private lazy var embeddedAgentVersion: String = {
        guard let url = Bundle.main.url(forResource: "EmbeddedModuleUpdate", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let info = try? JSONDecoder().decode(EmbeddedModuleUpdateInfo.self, from: data) else {
            return "0.3.7"
        }
        return info.version
    }()
    private let backgroundStandbyKey = "djonehub.background-standby-enabled"
    private let lowPowerModeKey = "djonehub.low-power-mode-enabled"
    private let liveActivityKey = "djonehub.live-activity-enabled"
    private let maxCallHistoryCount = 500
    private let maxMessageCount = 2_000

    init(api: DJOneHubAPI = DJOneHubAPI()) {
        self.api = api
        callKit.handler = self
        // 音频路由可能由 CallKit、蓝牙或系统控制中心改变，通话页按钮必须即时反映真实状态。
        audio.onSpeakerStateChanged = { [weak self] enabled in
            self?.isSpeakerEnabled = enabled
        }
    }

    func start() {
        guard !hasStarted else { return }
        hasStarted = true
        // 诊断器只监听系统网络路径并写入本地沙盒，不改变路由、DNS 或模块配置。
        Task { await NetworkDiagnosticRecorder.shared.start() }
        incomingNotifier.requestAuthorization()
        let storedValue = UserDefaults.standard.object(forKey: backgroundStandbyKey) as? Bool
        let storedLowPowerValue = UserDefaults.standard.object(forKey: lowPowerModeKey) as? Bool
        let storedLiveActivityValue = UserDefaults.standard.object(forKey: liveActivityKey) as? Bool
        lowPowerModeEnabled = storedLowPowerValue ?? true
        liveActivity.setEnabled(storedLiveActivityValue ?? true)
        backgroundStandby.setEnabled(storedValue ?? true)
        // 先加载手机副本，再启动轮询，避免模块暂时离线时界面显示为空。
        restoreLocalHistory()
        startCallEventBridgeIfNeeded()
        restartPolling()
    }

    /// 删除单条本机通话记录；模块仅保存待交付记录，因此不向模块发送删除请求。
    func deleteCallHistory(_ record: CallRecord) {
        let updatedHistory = callHistory.filter { $0.id != record.id }
        guard historyStore.saveCallHistory(updatedHistory) else {
            errorMessage = "无法删除本机通话记录，请稍后重试"
            return
        }
        callHistory = updatedHistory
        errorMessage = nil
    }

    /// 每次从锁屏或后台回来都舍弃旧连接，避免休眠前的超时结果覆盖新状态。
    func didBecomeActive() {
        appIsActive = true
        Task { await NetworkDiagnosticRecorder.shared.recordLifecycle("active") }
        consecutivePollFailures = 0
        backgroundStandby.setApplicationIsBackground(false)
        guard hasStarted else {
            start()
            return
        }
        // 手机重启后 App 可能先在受保护数据尚不可读时被后台唤醒。
        // 每次解锁回到前台重新合并磁盘副本，不能让首次空读取一直占据界面。
        restoreLocalHistory()
        // 休眠期间 USB ECM 可能重枚举。先取消旧请求并清空接口缓存，再创建全新的轮询与事件连接。
        api.resetLocalConnectionState()
        restartCallEventBridge()
        restartPolling()
    }

    func didEnterBackground() {
        appIsActive = false
        Task { await NetworkDiagnosticRecorder.shared.recordLifecycle("background") }
        backgroundStandby.setApplicationIsBackground(true)
    }

    func setBackgroundStandbyEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: backgroundStandbyKey)
        backgroundStandby.setEnabled(enabled)
    }

    func setLowPowerModeEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: lowPowerModeKey)
        lowPowerModeEnabled = enabled
        // 立即重建轮询任务，让用户切换后无需等待旧睡眠周期结束。
        if hasStarted { restartPolling() }
    }

    func setLiveActivityEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: liveActivityKey)
        liveActivity.setEnabled(enabled)
    }

    private func restartPolling() {
        pollingGeneration &+= 1
        let generation = pollingGeneration
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll(generation: generation)
                guard let delay = self?.nextPollingDelay else { return }
                try? await Task.sleep(for: .seconds(delay))
            }
        }
        // Mac 完整模式的轻量 Agent 不占用 AT 端口。手机检测到它后可自行请求
        // mobile 组合，避免用户在“离线”状态下无法手动切换模式。
        mobileProfileTask?.cancel()
        mobileProfileTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.attemptAutomaticMobileProfile()
                try? await Task.sleep(for: .milliseconds(750))
            }
        }
    }

    /// 模块在线时与其 1 秒 AT 轮询对齐；离线后退避，避免断开模块时持续唤醒手机和 USB 栈。
    private var nextPollingDelay: TimeInterval {
        if consecutivePollFailures > 0 {
            return min(3, pow(2, Double(consecutivePollFailures - 1)))
        }
        // 低耗电只影响后台空闲期；一旦发现通话立即恢复模块原生的 1 秒同步频率。
        if lowPowerModeEnabled, !appIsActive, activeCall == nil { return 2 }
        return 1
    }

    func stop() {
        pollingGeneration &+= 1
        pollingTask?.cancel()
        pollingTask = nil
        callEventTask?.cancel()
        callEventTask = nil
        mobileProfileTask?.cancel()
        mobileProfileTask = nil
        moduleUpdateTask?.cancel()
        moduleUpdateTask = nil
        moduleMetadataTask?.cancel()
        moduleMetadataTask = nil
        audio.deactivate()
        backgroundStandby.setEnabled(false)
        Task { await liveActivity.stop() }
        Task { try? await api.setAudioHostEnabled(false) }
    }

    /// 事件桥与 AppModel 同生命周期，前后台切换不重复创建长请求。
    /// 连接失败时指数退避，模块旧版本仍由现有轮询完整兜底。
    private func startCallEventBridgeIfNeeded() {
        guard callEventTask == nil else { return }
        callEventTask = Task { [weak self] in
            var revision: UInt64?
            var retryDelay: TimeInterval = 0.25
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let event = try await self.api.waitForCallEvent(after: revision)
                    guard !Task.isCancelled else { return }
                    revision = event.revision
                    retryDelay = 0.25
                    self.handleCallEvent(event)
                } catch {
                    guard !Task.isCancelled else { return }
#if DEBUG
                    print("[DJOneHub CallEvent] 事件桥暂时不可用：\(error.localizedDescription)")
#endif
                    try? await Task.sleep(for: .seconds(retryDelay))
                    retryDelay = min(retryDelay * 2, 15)
                }
            }
        }
    }

    /// 回到前台时必须重建长轮询；休眠前的阻塞请求不能继续代表当前 USB 路径。
    private func restartCallEventBridge() {
        callEventTask?.cancel()
        callEventTask = nil
        startCallEventBridgeIfNeeded()
    }

    /// 只在事件桥中处理对时延敏感的呼入上报，完整状态仍以轮询结果为权威数据。
    private func handleCallEvent(_ event: CallEventEnvelope) {
        guard let call = event.active,
              call.direction == "incoming",
              ["incoming", "waiting"].contains(call.state) else { return }
        let callerName = contacts.displayName(for: call.number)
        callKit.synchronize(call: call, previous: activeCall, callerName: callerName)
        if callKit.suppressesInAppIncomingRingtone {
            audio.stopCallTone()
        }
        if audioWarmupCallID != call.id {
            audioWarmupCallID = call.id
            // 来电事件到达后立即预热，不再等待下一次状态轮询。
            Task { [weak self] in try? await self?.api.warmAudioHost() }
        }
    }

    private func poll(generation: Int) async {
        do {
            let status = try await api.callStatus()
            guard !Task.isCancelled, generation == pollingGeneration else { return }
            let previousCall = activeCall
            let history = await mergeCallHistory(status.history ?? [])
            if activeCall != status.active { activeCall = status.active }
            if callHistory != history { callHistory = history }
            consecutivePollFailures = 0

            if let call = status.active,
               ["dialing", "alerting", "incoming", "waiting"].contains(call.state),
               audioWarmupCallID != call.id {
                audioWarmupCallID = call.id
                // 预热只加载驱动和校准，把最慢的冷启动提前到接通之前。
                Task { [weak self] in
                    try? await self?.api.warmAudioHost()
                }
            } else if status.active == nil, previousCall != nil {
                audioWarmupCallID = nil
            }
            // HTTP 已成功返回就说明 USB 模块代理在线。last_poll_error 只是模块内部 AT+CLCC
            // 的最近轮询结果，通话建立期间可能短暂非空，不能据此把整条 USB 链路判为离线。
            if !isOnline {
                isOnline = true
                // 只在离线到在线的边沿运行一次公网探测，避免跟随每秒轮询增加流量与耗电。
                Task { await NetworkDiagnosticRecorder.shared.recordModuleOnline() }
            }
            if connectionMessage != nil { connectionMessage = nil }
            scheduleModuleMetadataRefresh(generation: generation)
            let callerName = status.active.map { contacts.displayName(for: $0.number) }
            let confirmedEndedCall = previousCall.flatMap { previous in
                status.history?.first { $0.id == previous.id && $0.endedAt != nil }
            }
            // 必须先请求 CallKit，再决定是否发送本地通知。否则后台来电会同时出现
            // 系统通话界面和一条带接听按钮的通知；CallKit 上报失败时下一轮再自动降级。
            callKit.synchronize(
                call: status.active,
                previous: confirmedEndedCall ?? previousCall,
                callerName: callerName
            )
            await liveActivity.update(
                call: status.active,
                callerName: callerName,
                moduleOnline: true,
                radio: modemStatus,
                appIsActive: appIsActive
            )
            // CallKit 成功后由系统负责锁屏来电界面；仅在 CallKit 不可用或上报失败时发普通通知兜底。
            if !callKit.suppressesInAppIncomingRingtone {
                incomingNotifier.update(
                    call: status.active,
                    callerName: callerName,
                    appIsActive: appIsActive
                )
            }
            if status.active?.direction == "incoming", callKit.suppressesInAppIncomingRingtone {
                // CallKit 已负责系统铃声，不能再叠加应用内铃声。
                audio.stopCallTone()
            } else {
                audio.updateCallTone(for: status.active)
            }

            // 已完成首次向导的旧用户也要获得模块更新；仅在无通话时后台检查，避免中断基带媒体。
            if status.active == nil {
                scheduleAutomaticModuleUpdate()
            }

            // 接通期间持续确认本地音频仍在工作。CallKit 或系统音频服务重置后，
            // 即使模块状态没有发生变化，下一轮也必须能够重建网络 PCM。
            if status.active?.state == "active" {
                await startCallAudioIfReady()
            } else if status.active == nil, previousCall != nil {
                audio.deactivate()
                try? await api.setAudioHostEnabled(false)
                guard !Task.isCancelled, generation == pollingGeneration else { return }
                backgroundStandby.resumeAfterCall()
                isMuted = false
                isSpeakerEnabled = false
                isRecording = false
            }
            if status.active?.state == "active",
               Date() >= nextAudioDiagnosticRefresh,
               let audioConfig = try? await api.audioHostConfig() {
                // 诊断统计无需跟随每次通话轮询，降低额外 TCP 建连和 JSON 解码频率。
                nextAudioDiagnosticRefresh = Date().addingTimeInterval(3)
                audio.updateModuleDiagnostics(audioConfig)
            }
        } catch {
            guard !Task.isCancelled, generation == pollingGeneration else { return }
#if DEBUG
            print("[DJOneHub Poll] module status failed: \(error.localizedDescription)")
#endif
            consecutivePollFailures += 1
            // USB ECM 枚举、模块更新或 AT 忙时，单次 TCP 超时并不代表模块已经离线。
            // 连续三次失败后才改变用户可见状态，避免通话前后的状态灯频繁闪烁。
            if consecutivePollFailures >= 3 {
                if isOnline {
                    isOnline = false
                    Task {
                        await NetworkDiagnosticRecorder.shared.recordModuleOffline(
                            error: error.localizedDescription
                        )
                    }
                }
                audio.stopCallTone()
                await liveActivity.markOffline(appIsActive: appIsActive)
                // 后台轮询失败只更新离线状态；否则用户关闭弹窗后一秒又会被同一错误轰炸。
                connectionMessage = "模块控制连接失败：\(error.localizedDescription)"
            }
        }

        if appIsActive, Date() >= nextMessagesRefresh {
            // 短信由模块端独立轮询；App 后台无需重复拉取完整列表。
            nextMessagesRefresh = Date().addingTimeInterval(30)
            await refreshMessages(silently: true)
        }
    }

    /// 蜂窝状态和版本不必跟随每秒通话轮询；独立刷新避免慢 AT 状态接口拖住来电检测。
    private func scheduleModuleMetadataRefresh(generation: Int) {
        guard moduleMetadataTask == nil, Date() >= nextModuleMetadataRefresh else { return }
        nextModuleMetadataRefresh = Date().addingTimeInterval(10)
        moduleMetadataTask = Task { [weak self] in
            await self?.refreshModuleMetadata(generation: generation)
        }
    }

    private func refreshModuleMetadata(generation: Int) async {
        defer { moduleMetadataTask = nil }
        async let radioRequest = try? api.modemStatus()
        async let versionRequest = try? api.moduleUpdateStatus()
        // 复用十秒模块元数据刷新，不为长按弹窗新增独立轮询或后台耗电。
        async let powerRequest = try? api.systemPower()
        let (radio, versionStatus, power) = await (radioRequest, versionRequest, powerRequest)
        guard !Task.isCancelled, generation == pollingGeneration, isOnline else { return }
        if let radio { modemStatus = radio }
        if let version = versionStatus?.installedVersion, !version.isEmpty {
            agentVersion = version
        }
        if let power { systemPower = power }
        await liveActivity.update(
            call: activeCall,
            callerName: activeCall.map { contacts.displayName(for: $0.number) },
            moduleOnline: true,
            radio: modemStatus,
            appIsActive: appIsActive
        )
    }

    /// Mac 模式保留的控制服务只提供健康检查和 USB 模式切换。检测到它时，
    /// 自动切为手机直连组合；重枚举期间的连接失败属于预期，不污染离线提示。
    private func attemptAutomaticMobileProfile() async {
        // 后台不做高频模式探测，避免为了便利切换而持续消耗手机和模块电量。
        guard appIsActive, !mobileProfileSwitching, Date() >= nextMobileProfileAttempt else { return }
        mobileProfileSwitching = true
        nextMobileProfileAttempt = Date().addingTimeInterval(1)
        defer { mobileProfileSwitching = false }

        do {
            let profile = try await api.usbProfile()
            if profile.mode == "mac" {
                connectionMessage = "正在自动切换为手机直连模式…"
                _ = try await api.setUSBProfile("mobile")
            } else {
                // 已进入手机模式后降频探测；重新插拔会重建任务并立即重新检查。
                nextMobileProfileAttempt = Date().addingTimeInterval(15)
            }
        } catch {
            // USB 重枚举和控制 Agent 冷启动期间无法访问是正常情况。
        }
    }

    func dial() async {
        let number = Self.validatedNumber(numberInput)
        guard !number.isEmpty else { return }
        debugDialLog("开始直接提交模块拨号；呼出不经过 CallKit")
        await perform {
            // 呼出交给模块状态机，CallKit 继续仅负责呼入的锁屏界面和系统按键。
            // 这样不会额外等待 CXStartCallAction 的音频仲裁。
            self.resetControlsForNewCall()
            self.audio.stopCallTone()
            try await self.api.dial(number: number)
            // 仅当模块已确认接收拨号请求后清空，失败时保留号码供用户重试或修改。
            self.numberInput = ""
            self.debugDialLog("模块 ATD 请求成功")
        }
    }

    func answer() async {
        audio.stopCallTone()
        if callKit.managesCurrentCall {
            await perform {
                do {
                    try await self.callKit.answerCurrentCall()
                } catch CallKitBridgeError.staleSystemCall {
                    // 系统界面重建期间仍可直接接通模块端来电，避免按钮失效。
                    try await self.api.answerCall()
                }
            }
        } else {
            await perform { try await api.answerCall() }
        }
    }

    func reject() async {
        audio.stopCallTone()
        if callKit.managesCurrentCall {
            await perform {
                do {
                    try await self.callKit.endCurrentCall()
                } catch CallKitBridgeError.staleSystemCall {
                    _ = try await self.api.rejectCall()
                }
            }
        } else {
            await perform { _ = try await api.rejectCall() }
        }
    }

    func hangup() async {
        audio.stopCallTone()
        if callKit.managesCurrentCall {
            await perform {
                do {
                    try await self.callKit.endCurrentCall()
                } catch CallKitBridgeError.staleSystemCall {
                    try await self.api.hangupCall()
                }
            }
        } else {
            await perform { try await api.hangupCall() }
        }
    }
    func sendDTMF(_ digit: String) async {
        await perform {
            if self.callKit.managesCurrentCall {
                do {
                    // App 内键盘与系统通话页共用 CallKit 事务，避免两边的 DTMF 顺序不一致。
                    try await self.callKit.playDTMF(digit)
                } catch CallKitBridgeError.staleSystemCall {
                    // 系统通话 UUID 刚被重建时，模块通话仍然有效；直接降级发送一次按键。
                    try await self.api.sendDTMF(digit)
                }
            } else {
                try await self.api.sendDTMF(digit)
            }
        }
    }

    /// 首次接入或用户点“重新检测”时串行完成版本、AT、语音和 USB 模式自检。
    func prepareModuleForFirstConnection() async {
        guard !preparingModule else { return }
        preparingModule = true
        defer { preparingModule = false }
        do {
            setupStage = .connecting
            let updateStatus = try await api.moduleUpdateStatus()
            agentVersion = updateStatus.installedVersion
            if updateStatus.supported,
               ModuleUpdatePolicy.shouldInstall(
                   installed: updateStatus.installedVersion ?? "0.0.0",
                   available: embeddedAgentVersion
               ),
               let packageURL = Bundle.main.url(forResource: "module-update", withExtension: "djupdate") {
                setupStage = .updating
                _ = try await api.uploadModuleUpdate(from: packageURL)
                try await waitForModuleAgent()
            }

            setupStage = .initializing
            let setup = try await api.moduleSetupStatus()
            if setup.canInitialize { _ = try await api.initializeModule() }

            setupStage = .checkingAudio
            let voice = try await api.voiceRuntimeStatus()
            guard voice.ready else {
                throw ModuleSetupError.notReady(voice.runtimeDetail ?? "模块语音运行时未就绪")
            }
            guard await audio.requestMicrophonePermission() else {
                throw ModuleSetupError.notReady("请允许 DJOneHub 使用麦克风后重试")
            }
            let profile = try await api.usbProfile()
            if profile.mode == "mac" {
                _ = try await api.setUSBProfile("mobile")
                try await waitForModuleAgent()
            }
            setupStage = .ready
            UserDefaults.standard.set(true, forKey: "djonehub.first-connection-complete")
        } catch {
            setupStage = .failed(error.localizedDescription)
        }
    }

    func resetModuleSetup() {
        setupStage = .idle
        UserDefaults.standard.set(false, forKey: "djonehub.first-connection-complete")
    }

    private func waitForModuleAgent() async throws {
        for _ in 0..<20 {
            try await Task.sleep(for: .seconds(1))
            // 代理能响应即表示 USB 控制链路已经恢复；AT 子系统的瞬时错误不应阻塞接入向导。
            if (try? await api.callStatus()) != nil { return }
        }
        throw ModuleSetupError.timeout
    }

    private func scheduleAutomaticModuleUpdate() {
        guard moduleUpdateTask == nil, Date() >= nextModuleUpdateAttempt else { return }
        moduleUpdateTask = Task { [weak self] in
            await self?.installAutomaticModuleUpdateIfNeeded()
        }
    }

    private func installAutomaticModuleUpdateIfNeeded() async {
        defer { moduleUpdateTask = nil }
        do {
            let status = try await api.moduleUpdateStatus()
            agentVersion = status.installedVersion
            guard status.supported,
                  ModuleUpdatePolicy.shouldInstall(
                      installed: status.installedVersion ?? "0.0.0",
                      available: embeddedAgentVersion
                  ) else {
                // 当前 App 生命周期内无需重复请求版本接口。
                nextModuleUpdateAttempt = .distantFuture
                return
            }
            guard let packageURL = Bundle.main.url(
                forResource: "module-update",
                withExtension: "djupdate"
            ) else {
                nextModuleUpdateAttempt = Date().addingTimeInterval(30)
                return
            }
            _ = try await api.uploadModuleUpdate(from: packageURL)
            try await waitForModuleAgent()
            nextModuleUpdateAttempt = .distantFuture
        } catch is CancellationError {
            return
        } catch {
            // 模块重启或 USB 网络尚未稳定时退避重试，不用后台错误弹窗打断用户。
            nextModuleUpdateAttempt = Date().addingTimeInterval(30)
        }
    }

    func toggleMute() async {
        let target = !isMuted
        if callKit.managesCurrentCall {
            do {
                try await callKit.setMuted(target)
                errorMessage = nil
            } catch {
                // CallKit UUID 可能因系统重置而短暂失效；本地 PCM 仍可可靠控制麦克风。
                if case CallKitBridgeError.staleSystemCall = error {
                    isMuted = target
                    audio.setMuted(target)
                    errorMessage = nil
                } else {
                    errorMessage = "系统静音切换失败：\(error.localizedDescription)"
                }
            }
            return
        }
        // 移动端上行语音由本地 PCM 管线产生，必须先本地静音，不能依赖模块 AT 命令成功。
        isMuted = target
        audio.setMuted(target)
        // QDC507 部分固件不实现 AT+CMUT；本地 PCM 已经是移动端的权威静音状态，
        // 后台同步失败不能阻断通话或弹出误导性的“麦克风已静音”错误。
        Task { try? await api.setAudioMuted(target) }
        errorMessage = nil
    }

    func toggleSpeaker() {
        let target = !isSpeakerEnabled
        do {
            // 扬声器切换只作用于当前系统音频会话，不需要向模块发送控制命令。
            try audio.setSpeakerEnabled(target)
            // 以 AVAudioSession 实际路由为准，避免系统因蓝牙/听筒抢占导致 UI 假状态。
            isSpeakerEnabled = audio.speakerEnabled
            errorMessage = nil
        } catch {
            errorMessage = "无法切换通话输出：\(error.localizedDescription)"
        }
    }

    func toggleRecording() async {
        let target = !isRecording
        do {
            let response = try await api.setCallRecording(target)
            isRecording = response.recording
            errorMessage = nil
        } catch {
            debugDialLog("操作失败：\(error.localizedDescription)")
            errorMessage = error.localizedDescription
        }
    }

    /// 真机联调阶段输出拨号链路，不记录电话号码；Release 构建会完全移除。
    private func debugDialLog(_ message: String) {
#if DEBUG
        print("[DJOneHub Dial] \(message)")
#endif
    }

    func sendSMS(to phone: String, content: String) async -> Bool {
        let target = Self.validatedNumber(phone)
        let body = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, !body.isEmpty, body.count <= 2_000 else { return false }
        do {
            let result = try await api.sendSMS(to: target, message: body)
            if result.sent {
                // 模块的短信收件箱通常不会回传已发送内容，不能等刷新接口来补这一条。
                // 先落盘再刷新，断线、重启模块或自动清理都不会让已发送短信消失。
                saveSentMessage(recipient: target, content: body)
            }
            await refreshMessages(silently: true)
            return result.sent
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func refreshMessages(silently: Bool = false) async {
        do {
            try await api.refreshSMS()
            let remoteMessages = try await api.messages()
            let mergedMessages = await mergeMessages(remoteMessages)
            if messages != mergedMessages { messages = mergedMessages }
            if !silently { errorMessage = nil }
        } catch {
            if !silently { errorMessage = error.localizedDescription }
        }
    }

    func clearLocalMessages() {
        guard historyStore.saveMessages([]) else {
            errorMessage = "无法清空本机短信，请稍后重试"
            return
        }
        messages = []
        errorMessage = nil
    }

    /// 将磁盘副本并入当前内存，只增加或更新记录，绝不以空读取清掉现有界面数据。
    private func restoreLocalHistory() {
        let storedCalls = historyStore.loadCallHistory()
        if !storedCalls.isEmpty {
            var callsByID: [String: CallRecord] = [:]
            for record in callHistory { callsByID[record.id] = record }
            for record in storedCalls {
                if let existing = callsByID[record.id], existing.updatedAt >= record.updatedAt { continue }
                callsByID[record.id] = record
            }
            callHistory = normalizedCallHistory(Array(callsByID.values))
        }

        let storedMessages = historyStore.loadMessages()
        if !storedMessages.isEmpty {
            var messagesByID: [String: SMSMessage] = [:]
            for message in messages { messagesByID[message.id] = message }
            for message in storedMessages { messagesByID[message.id] = message }
            messages = normalizedMessages(Array(messagesByID.values))
        }
    }

    /// 远端列表可能因模块重启、自动清理或离线而变短，因此只做并集，不删除手机副本。
    private func mergeCallHistory(_ remote: [CallRecord]) async -> [CallRecord] {
        var byID: [String: CallRecord] = [:]
        for record in callHistory {
            if let existing = byID[record.id], existing.updatedAt >= record.updatedAt { continue }
            byID[record.id] = record
        }
        for record in remote {
            if let local = byID[record.id], local.updatedAt > record.updatedAt {
                continue
            }
            byID[record.id] = record
        }
        let merged = normalizedCallHistory(Array(byID.values))
        if !remote.isEmpty, historyStore.saveCallHistory(merged) {
            // 只有手机副本写入成功才确认模块，断线时模块仍会保留未交付队列。
            let persistedIDs = Set(merged.map(\.id))
            let acknowledgedIDs = remote.map(\.id).filter { persistedIDs.contains($0) }
            try? await api.acknowledgeCallHistory(ids: acknowledgedIDs)
        }
        return merged
    }

    private func mergeMessages(_ remote: [SMSMessage]) async -> [SMSMessage] {
        var byID: [String: SMSMessage] = [:]
        for message in messages { byID[message.id] = message }
        for var message in remote {
            // 旧版模块没有 delivery_id 时保留手机已有标识，避免新旧版本来回覆盖。
            if message.deliveryID == nil { message.deliveryID = byID[message.id]?.deliveryID }
            byID[message.id] = message
        }
        let merged = normalizedMessages(Array(byID.values))
        if !remote.isEmpty, historyStore.saveMessages(merged) {
            let persistedIDs = Set(merged.map(\.id))
            let acknowledgedIDs = remote
                .filter { persistedIDs.contains($0.id) }
                .compactMap(\.deliveryID)
            try? await api.acknowledgeMessages(ids: acknowledgedIDs)
        }
        return merged
    }

    /// 将发送成功的短信保存为本机记录；`sender` 这里表示对话对端，沿用既有会话分组方式。
    private func saveSentMessage(recipient: String, content: String) {
        let sentMessage = SMSMessage(
            sender: recipient,
            content: content,
            code: nil,
            timestamp: .now,
            deliveryID: nil,
            direction: .outgoing
        )
        let updatedMessages = normalizedMessages(messages + [sentMessage])
        messages = updatedMessages
        if !historyStore.saveMessages(updatedMessages) {
            // 仍在当前界面保留该记录，避免用户重复发送；下次刷新会再次尝试写入最新列表。
            errorMessage = "短信已发送，但保存到本机失败，请稍后刷新确认"
        }
    }

    private func normalizedCallHistory(_ records: [CallRecord]) -> [CallRecord] {
        Array(records
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(maxCallHistoryCount))
    }

    private func normalizedMessages(_ records: [SMSMessage]) -> [SMSMessage] {
        Array(records
            .sorted { $0.timestamp > $1.timestamp }
            .prefix(maxMessageCount))
    }

    private func perform(_ operation: () async throws -> Void) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await operation()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startCallAudioIfReady() async {
        guard activeCall?.state == "active", !audio.active, !startingCallAudio else { return }
        let callID = activeCall?.id
        let managedByCallKit = callKit.managesCurrentCall
        guard !managedByCallKit || callKit.audioSessionIsActive else { return }
        startingCallAudio = true
        defer { startingCallAudio = false }
        backgroundStandby.suspendForCall()

        // Agent 在基带状态进入 active 时已经自动启动模块 PCM。这里绝不能再发送
        // “停止后启动”，否则会杀掉刚完成的 D4/D5/D6 路由并重新产生 8 秒冷启动。
        // CallKit 激活时也不能手动 setActive，否则系统通话路由会被应用抢占。
        guard await audio.activateForCall(sessionAlreadyActive: managedByCallKit) else {
            backgroundStandby.resumeAfterCall()
            return
        }
        // 模块轮询也会在 active 状态拉起语音桥，但主动发起一次请求可以消除
        // “手机先启动 PCM、模块下一轮轮询才发现”的竞速，减少首次握手等待。
        try? await api.setAudioHostEnabled(true)
        // 请求可能与对端挂断并行完成；过期请求不得在下一通电话前重新拉起语音桥。
        if activeCall?.id != callID || activeCall?.state != "active" {
            try? await api.setAudioHostEnabled(false)
        }
    }

    /// 仅允许电话网络常见字符，防止意外把 AT 控制字符传入模块代理。
    private static func validatedNumber(_ input: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowed = CharacterSet(charactersIn: "+*#0123456789")
        guard trimmed.count <= 82,
              trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return "" }
        return trimmed
    }
}

extension AppModel: CallKitActionHandling {
    func callKitStart(number: String) async throws {
        // 呼出由 App、Siri 或系统联系人发起时都要从听筒开始。
        resetControlsForNewCall()
        audio.stopCallTone()
        backgroundStandby.suspendForCall()
        do {
            try audio.prepareForCallKit()
            try await api.dial(number: number)
        } catch {
            backgroundStandby.resumeAfterCall()
            throw error
        }
    }

    func callKitAnswer() async throws {
        audio.stopCallTone()
        backgroundStandby.suspendForCall()
        do {
            try audio.prepareForCallKit()
            try await api.answerCall()
        } catch {
            backgroundStandby.resumeAfterCall()
            throw error
        }
    }

    func callKitEnd() async throws {
        audio.stopCallTone()
        if activeCall?.direction == "incoming",
           let state = activeCall?.state,
           ["incoming", "waiting"].contains(state) {
            _ = try await api.rejectCall()
        } else {
            try await api.hangupCall()
        }
    }

    func callKitSetMuted(_ muted: Bool) async {
        isMuted = muted
        audio.setMuted(muted)
        // CallKit 的静音动作直接作用于本地 PCM 编码器；模块 AT+CMUT 失败不应影响双向音频。
        Task { try? await api.setAudioMuted(muted) }
        errorMessage = nil
    }

    func callKitPlayDTMF(_ digits: String) async throws {
        for digit in digits where "0123456789*#".contains(digit) {
            try await api.sendDTMF(String(digit))
        }
    }

    func callKitAudioSessionDidActivate() async {
        await startCallAudioIfReady()
    }

    func callKitAudioSessionDidDeactivate() {
        let callStillActive = activeCall?.state == "active"
        // 切换免提或系统重建路由时可能短暂失活；保留用户路由与模块 PCM，等待 didActivate 快速恢复。
        audio.deactivate(preservingCallKitRoute: callStillActive)
        audioWarmupCallID = nil
        guard !callStillActive else { return }
        backgroundStandby.resumeAfterCall()
        Task { try? await api.setAudioHostEnabled(false) }
    }

    func callKitProviderDidReset() async {
        // CXProvider reset 只代表系统通话界面失效，绝不等于用户挂断真实模块通话。
        // 清理本地音频后交给下一轮状态同步按 App 内通话模式自动恢复。
        let callStillActive = activeCall?.state == "active"
        audio.deactivate(preservingCallKitRoute: callStillActive)
        if callStillActive {
            // 模块路由保持预热，下一轮轮询只需重建手机侧音频引擎。
            return
        }
        try? await api.setAudioHostEnabled(false)
        backgroundStandby.resumeAfterCall()
    }

    func callKitDidFail(_ message: String) {
        errorMessage = message
    }

    private func resetControlsForNewCall() {
        isMuted = false
        isSpeakerEnabled = false
        audio.resetControlsForNewCall()
    }
}

private enum ModuleSetupError: LocalizedError {
    case notReady(String)
    case timeout

    var errorDescription: String? {
        switch self {
        case let .notReady(message): return message
        case .timeout: return "模块重启后未重新上线，请重新插拔 USB 线"
        }
    }
}
