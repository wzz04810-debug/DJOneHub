import SwiftUI
import UIKit
import UIKit

/// 仅在当天显示具体时分；更早的记录显示日期，避免长列表全部挤成相同的时间。
enum RecentCallTimeFormatter {
    static func string(for date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let day = calendar.dateComponents([.year, .month, .day], from: date)
        let currentDay = calendar.dateComponents([.year, .month, .day], from: now)
        if day == currentDay {
            let time = calendar.dateComponents([.hour, .minute], from: date)
            return String(format: "%02d:%02d", time.hour ?? 0, time.minute ?? 0)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           day == calendar.dateComponents([.year, .month, .day], from: yesterday) {
            return "昨天"
        }
        if day.year == currentDay.year {
            return String(format: "%02d/%02d", day.month ?? 0, day.day ?? 0)
        }
        return String(format: "%04d/%02d/%02d", day.year ?? 0, day.month ?? 0, day.day ?? 0)
    }
}

/// 点击记录前统一校验号码，防止异常历史记录触发空号码拨号。
enum RecentCallDialPolicy {
    static func numberToDial(_ number: String?) -> String? {
        guard let number, !number.isEmpty else { return nil }
        return number
    }
}

/// 拨号盘删除保持单字符语义，避免长按时因输入为空触发越界删除。
enum DialPadDeletePolicy {
    static func removingLast(from number: String) -> String {
        String(number.dropLast())
    }
}

// MARK: - 拨号

struct DialPadView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let onSettings: () -> Void
    @State private var deleteRepeatTask: Task<Void, Never>?
    @State private var zeroWasLongPressed = false
    @State private var showingModuleStatus = false
    @State private var moduleStatusPopoverPresented = false
    @State private var moduleStatusFeedback = UIImpactFeedbackGenerator(style: .medium)
    @State private var moduleStatusPillPressed = false
    @State private var dialKeyFeedback = DialKeyFeedback()

    private let rows = [
        [("1", ""), ("2", "ABC"), ("3", "DEF")],
        [("4", "GHI"), ("5", "JKL"), ("6", "MNO")],
        [("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ")],
        [("*", ""), ("0", "+"), ("#", "")],
    ]

    private var matchedName: String? {
        model.contacts.contact(for: model.numberInput)?.name
    }

    private var isCompact: Bool { horizontalSizeClass == .compact }
    // 三列按键共用固定轨道，避免窄屏时拨号、删除与数字键的中心线错位。
    private var keySize: CGFloat { isCompact ? 82 : 90 }
    private var keySpacing: CGFloat { isCompact ? 24 : 30 }
    private var rowSpacing: CGFloat { isCompact ? 14 : 18 }
    private var keypadWidth: CGFloat { keySize * 3 + keySpacing * 2 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: isCompact ? 16 : 22) {
                    dialPageHeader
                        // 弹窗需盖在号码输入区之上，不能被后续的拨号盘视图遮住。
                        .zIndex(showingModuleStatus ? 1 : 0)

                    VStack(spacing: 2) {
                        Text(model.numberInput.isEmpty ? L10n.t("输入号码") : model.numberInput)
                            .font(.system(size: isCompact ? 36 : 42, weight: .light, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(model.numberInput.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.45)
                            .frame(height: 50)

                        Text(matchedName ?? " ")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.green)
                            .frame(height: 22)
                    }
                    .padding(.horizontal, 12)

                    VStack(spacing: rowSpacing) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            HStack(spacing: keySpacing) {
                                ForEach(row, id: \.0) { digit, letters in
                                    DialKey(digit: digit, letters: letters)
                                }
                            }
                        }
                    }
                    .frame(width: keypadWidth)

                    HStack(spacing: keySpacing) {
                        Color.clear.frame(width: keySize, height: keySize)
                        Button {
                            Task { await model.dial() }
                        } label: {
                            Circle()
                                .fill(.green)
                                .frame(width: keySize, height: keySize)
                                .overlay {
                                    Image(systemName: "phone.fill")
                                        .font(.system(size: isCompact ? 27 : 30, weight: .semibold))
                                        .foregroundStyle(.white)
                                }
                        }
                        .buttonStyle(.plain)
                        .disabled(model.numberInput.isEmpty || model.isBusy || !model.isOnline)
                        .opacity(model.numberInput.isEmpty || !model.isOnline ? 0.4 : 1)

                        Image(systemName: "delete.left")
                            .font(.system(size: isCompact ? 22 : 24))
                            .foregroundStyle(.secondary)
                            .frame(width: keySize, height: keySize)
                            .contentShape(Rectangle())
                            // minimumDistance 为零可在手指落下时立即响应，避免长按识别造成迟滞。
                            .gesture(deleteGesture)
                            .allowsHitTesting(!model.numberInput.isEmpty)
                            .opacity(model.numberInput.isEmpty ? 0.4 : 1)
                            .accessibilityLabel(L10n.t("删除"))
                            .accessibilityHint(L10n.t("轻点删除一位，长按连续删除"))
                            .accessibilityAddTraits(.isButton)
                    }
                    // 与数字键使用同一列距，视觉与点击位置都更接近系统电话。
                    .frame(width: keypadWidth)
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
            .background(PhoneBackdrop())
            // 只在背景普通点击时收起，避免与状态标签的长按结束事件发生竞争。
            .onTapGesture { dismissModuleStatusPopover() }
            // 导航栏只承担设置入口；标题和状态放在页面内容区，避免窄屏互相挤压。
            .navigationBarTitleDisplayMode(.inline)
            .settingsToolbarButton {
                // 设置入口与状态弹窗属于同一页面状态；跳转前收起，返回拨号页时不会残留。
                dismissModuleStatusPopover()
                onSettings()
            }
            .onDisappear(perform: stopRepeatingDelete)
        }
    }

    private func deleteLastDigit() {
        guard !model.numberInput.isEmpty else { return }
        model.numberInput = DialPadDeletePolicy.removingLast(from: model.numberInput)
    }

    private func playDialKeySound() {
        // 使用 iOS 原生输入点击音；通话静音时不发声，且仍服从系统“键盘反馈”设置。
        guard !model.isMuted else { return }
        dialKeyFeedback.play()
    }

    private func beginDeleting() {
        guard deleteRepeatTask == nil, !model.numberInput.isEmpty else { return }
        // 手指落下就删除一位；仍按住超过 0.35 秒才开始连续删除，短按不会多删。
        deleteLastDigit()
        deleteRepeatTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 350_000_000)
            } catch {
                return
            }
            while !Task.isCancelled, !model.numberInput.isEmpty {
                deleteLastDigit()
                try? await Task.sleep(nanoseconds: 90_000_000)
            }
            deleteRepeatTask = nil
        }
    }

    private func stopRepeatingDelete() {
        deleteRepeatTask?.cancel()
        deleteRepeatTask = nil
    }

    private func dismissModuleStatusPopover() {
        guard showingModuleStatus else { return }
        withAnimation(.easeOut(duration: 0.18)) {
            moduleStatusPopoverPresented = false
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(190))
            guard !moduleStatusPopoverPresented else { return }
            showingModuleStatus = false
        }
    }

    private var deleteGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in beginDeleting() }
            .onEnded { _ in stopRepeatingDelete() }
    }

    private var dialPageHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(L10n.t("拨号"))
                .font(.system(size: isCompact ? 32 : 36, weight: .bold, design: .rounded))
                .accessibilityAddTraits(.isHeader)

            Spacer(minLength: 12)

            dialStatusPill
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var dialStatusPill: some View {
        HStack(spacing: 7) {
            Image(systemName: model.isOnline ? "antenna.radiowaves.left.and.right" : "cable.connector.slash")
                .font(.caption.weight(.semibold))
                .foregroundStyle(model.isOnline ? .green : .red)

            Text(model.isOnline ? L10n.t("模块在线") : L10n.t("模块离线"))
                .font(.caption.weight(.medium))
                .foregroundStyle(model.isOnline ? .green : .red)
                .lineLimit(1)

            Circle()
                .fill(model.isOnline ? Color.green : Color.red)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(
            (model.isOnline ? Color.green : Color.red).opacity(0.12),
            in: Capsule()
        )
        .contentShape(Capsule())
        // 现代设备不再提供压力值，用短按压缩放加触感模拟系统的 Haptic Touch。
        .scaleEffect(moduleStatusPillPressed ? 0.94 : 1)
        .animation(.easeOut(duration: 0.12), value: moduleStatusPillPressed)
        .onLongPressGesture(
            // 缩短触发时间并允许轻微手指漂移，保证单手操作也能稳定识别。
            minimumDuration: 0.18,
            maximumDistance: 36,
            perform: {
                moduleStatusFeedback.impactOccurred()
                moduleStatusFeedback.prepare()
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    showingModuleStatus = true
                }
            },
            onPressingChanged: { pressing in
                moduleStatusPillPressed = pressing
                if pressing { moduleStatusFeedback.prepare() }
            }
        )
        // 弹窗锚定在标签本身下方，避免 iPhone 将 popover 自动转换成底部大面板。
        .overlay(alignment: .topTrailing) {
            if showingModuleStatus {
                ModuleStatusPopover(onDismiss: dismissModuleStatusPopover)
                    .environmentObject(model)
                    // 与功率详情保持一致：从状态标签下方轻微上浮并回弹。
                    .scaleEffect(moduleStatusPopoverPresented ? 1 : 0.92, anchor: .topTrailing)
                    .offset(y: moduleStatusPopoverPresented ? 44 : 58)
                    .opacity(moduleStatusPopoverPresented ? 1 : 0)
                    .onAppear {
                        withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) {
                            moduleStatusPopoverPresented = true
                        }
                    }
                    .zIndex(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.isOnline ? L10n.t("模块在线") : L10n.t("模块离线"))
        .accessibilityHint("按住查看模块状态")
    }

    @ViewBuilder
    private func DialKey(digit: String, letters: String) -> some View {
        Button {
            // 长按 0 已输入加号；抬手时忽略 Button 的默认点击，避免得到“0+”。
            guard !(digit == "0" && zeroWasLongPressed) else {
                zeroWasLongPressed = false
                return
            }
            model.numberInput.append(digit)
            playDialKeySound()
        } label: {
            VStack(spacing: 1) {
                Text(digit).font(.system(size: isCompact ? 33 : 36, weight: .regular, design: .rounded))
                Text(letters).font(.system(size: isCompact ? 10 : 11, weight: .semibold)).tracking(1.4)
            }
            .foregroundStyle(.primary)
            .frame(width: keySize, height: keySize)
            .background(Color(uiColor: .secondarySystemFill), in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.45).onEnded { _ in
                if digit == "0" {
                    zeroWasLongPressed = true
                    model.numberInput.append("+")
                }
            }
        )
        .accessibilityLabel(letters.isEmpty ? digit : "\(digit) \(letters)")
    }
}

/// 复用系统输入点击音，避免自定义音频会话干扰正在进行的通话路由。
private final class DialKeyFeedback {
    func play() {
        UIDevice.current.playInputClick()
    }
}

// MARK: - 模块状态

private struct ModuleStatusPopover: View {
    @EnvironmentObject private var model: AppModel
    let onDismiss: () -> Void

    private var modem: ModemStatus? { model.modemStatus }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                Image(systemName: model.isOnline ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(model.isOnline ? .green : .red)
                Text("模块状态")
                    .font(.headline)
                Spacer()
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.t("关闭"))
            }

            Text(connectionDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            statusRow("Agent", model.agentVersion ?? (model.isOnline ? "读取中" : "--"))
            statusRow(L10n.t("运营商"), modem?.operatorName ?? "--")
            statusRow(L10n.t("网络模式"), modem?.networkMode ?? "--")
            statusRow(L10n.t("信号强度"), modem?.signalDBM.map { "\($0) dBm" } ?? "--")
            statusRow(L10n.t("SIM 卡"), modem?.simInserted == true ? "已接入" : "未接入")

        }
        .padding(16)
        .frame(width: 286, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }

    private var connectionDescription: String {
        guard !model.isOnline else { return "USB ECM 已连接，状态会自动刷新" }
        return model.connectionMessage ?? "请检查模块连接与 USB ECM 网络"
    }


    private func statusRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.caption.weight(.medium))
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
        }
    }
}

// MARK: - 最近通话

struct RecentsView: View {
    @EnvironmentObject private var model: AppModel
    let onCall: (String) -> Void
    let onMessage: (String) -> Void
    let onSettings: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if model.callHistory.isEmpty {
                    EmptyStateView(
                        title: L10n.t("暂无通话记录"),
                        systemImage: "phone.arrow.up.right"
                    )
                } else {
                    List(model.callHistory) { call in
                        // 点击整条记录直接回拨；没有号码的异常记录仍保持只读显示。
                        Button {
                            if let number = RecentCallDialPolicy.numberToDial(call.number) {
                                onCall(number)
                            }
                        } label: {
                                CallHistoryRow(call: call)
                                    .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(RecentCallDialPolicy.numberToDial(call.number) == nil)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                model.deleteCallHistory(call)
                            } label: {
                                Label(L10n.t("删除"), systemImage: "trash")
                            }
                            .tint(.red)
                            if let number = call.number {
                                Button { onMessage(number) } label: {
                                    Label(L10n.t("短信"), systemImage: "message.fill")
                                }
                                .tint(.blue)
                                Button { onCall(number) } label: {
                                    Label(L10n.t("拨号"), systemImage: "phone.fill")
                                }
                                .tint(.green)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .background(PhoneBackdrop())
            .navigationTitle(L10n.t("最近通话"))
            .settingsToolbarButton(action: onSettings)
        }
    }

    private struct CallHistoryRow: View {
        @EnvironmentObject private var model: AppModel
        let call: CallRecord

        var body: some View {
            HStack(spacing: 12) {
                Image(systemName: call.direction == "incoming" ? "phone.arrow.down.left" : "phone.arrow.up.right")
                    .foregroundStyle(call.missed ? .red : .green)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.contacts.displayName(for: call.number))
                        .font(.body.weight(.semibold))
                        .foregroundStyle(call.missed ? .red : .primary)
                    Text(call.missed ? L10n.t("未接") : (call.direction == "incoming" ? L10n.t("呼入") : L10n.t("呼出")))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                // 最近通话显示发生时刻；跨天时改为日期，避免用户误把旧记录当作今天。
                Text(RecentCallTimeFormatter.string(for: call.startedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 5)
        }
    }
}

// MARK: - 短信

struct MessagesView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var pendingRecipient: String?
    let onSettings: () -> Void
    @State private var showingComposer = false
    @State private var showingClearConfirmation = false

    private var conversations: [(sender: String, messages: [SMSMessage])] {
        Dictionary(grouping: model.messages, by: \.sender)
            .map { ($0.key, $0.value.sorted { $0.timestamp < $1.timestamp }) }
            .sorted { ($0.messages.last?.timestamp ?? .distantPast) > ($1.messages.last?.timestamp ?? .distantPast) }
    }

    var body: some View {
        NavigationStack {
            List {
                if conversations.isEmpty {
                    EmptyStateView(title: L10n.t("暂无短信"), systemImage: "message")
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(conversations, id: \.sender) { conversation in
                        NavigationLink {
                            MessageThreadView(sender: conversation.sender, messages: conversation.messages)
                        } label: {
                            MessageConversationRow(sender: conversation.sender, messages: conversation.messages)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .background(PhoneBackdrop())
            .navigationTitle(L10n.t("短信"))
            .settingsToolbarButton(action: onSettings)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { Task { await model.refreshMessages() } } label: {
                            Label(L10n.t("刷新"), systemImage: "arrow.clockwise")
                        }
                        Button(role: .destructive) { showingClearConfirmation = true } label: {
                            Label(L10n.t("清空全部短信"), systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingComposer = true } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
            }
            .task {
                await model.refreshMessages(silently: true)
            }
            .onChange(of: pendingRecipient) { recipient in
                if recipient != nil { showingComposer = true }
            }
            .sheet(isPresented: $showingComposer, onDismiss: { pendingRecipient = nil }) {
                MessageComposer(initialRecipient: pendingRecipient ?? "")
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .confirmationDialog(L10n.t("清空全部短信"), isPresented: $showingClearConfirmation, titleVisibility: .visible) {
                Button(L10n.t("删除"), role: .destructive) {
                    Task {
                        try? await model.api.clearModuleSMS()
                        model.clearLocalMessages()
                    }
                }
                Button(L10n.t("取消"), role: .cancel) {}
            } message: {
                Text("这会删除本机短信以及尚未交付的模块短信，无法恢复。")
            }
        }
    }

    private struct MessageConversationRow: View {
        @EnvironmentObject private var model: AppModel
        let sender: String
        let messages: [SMSMessage]

        var body: some View {
            HStack(spacing: 12) {
                InitialAvatar(name: model.contacts.displayName(for: sender))
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.contacts.displayName(for: sender)).font(.body.weight(.semibold))
                    Text(messages.last?.content ?? "").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(messages.last?.timestamp ?? .now, style: .time)
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }
}

private struct MessageThreadView: View {
    @EnvironmentObject private var model: AppModel
    let sender: String
    let messages: [SMSMessage]
    @State private var reply = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 9) {
                        ForEach(messages) { message in
                            HStack {
                                if message.isOutgoing { Spacer(minLength: 48) }
                                VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 3) {
                                    Text(message.content)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 9)
                                        .background(
                                            message.isOutgoing ? Color.accentColor : Color(uiColor: .secondarySystemBackground),
                                            in: RoundedRectangle(cornerRadius: 18)
                                        )
                                        .foregroundStyle(message.isOutgoing ? .white : .primary)
                                    if message.isOutgoing {
                                        Text(L10n.t("已发送"))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                if !message.isOutgoing { Spacer(minLength: 48) }
                            }
                            .id(message.id)
                        }
                    }
                    .padding()
                }
                .onAppear { if let id = messages.last?.id { proxy.scrollTo(id) } }
            }
            Divider()
            HStack(spacing: 10) {
                TextField(L10n.t("短信内容"), text: $reply, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Button {
                    let body = reply
                    reply = ""
                    Task { _ = await model.sendSMS(to: sender, content: body) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding()
        }
        .navigationTitle(model.contacts.displayName(for: sender))
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct MessageComposer: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var recipient: String
    @State private var content = ""
    @State private var sending = false

    init(initialRecipient: String) { _recipient = State(initialValue: initialRecipient) }

    var body: some View {
        NavigationStack {
            Form {
                TextField(L10n.t("收件人"), text: $recipient)
                    .keyboardType(.phonePad)
                TextField(L10n.t("短信内容"), text: $content, axis: .vertical)
                    .lineLimit(5...12)
            }
            .navigationTitle(L10n.t("新信息"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.t("取消")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.t("发送")) {
                        sending = true
                        Task {
                            if await model.sendSMS(to: recipient, content: content) { dismiss() }
                            sending = false
                        }
                    }
                    .disabled(sending || recipient.isEmpty || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

// MARK: - 通讯录

struct ContactsView: View {
    @EnvironmentObject private var model: AppModel
    let onCall: (String) -> Void
    let onMessage: (String) -> Void
    let onSettings: () -> Void
    @State private var search = ""

    private var filtered: [ContactStore.Contact] {
        guard !search.isEmpty else { return model.contacts.contacts }
        return model.contacts.contacts.filter {
            $0.name.localizedCaseInsensitiveContains(search) || $0.phones.contains { $0.contains(search) }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if !model.contacts.isAuthorized {
                    EmptyStateView(
                        title: L10n.t("授权访问通讯录"),
                        systemImage: "person.crop.circle.badge.questionmark",
                        actionTitle: L10n.t("授权访问通讯录")
                    ) {
                        Task { await model.contacts.requestAccessAndLoad() }
                    }
                } else if filtered.isEmpty {
                    EmptyStateView(title: L10n.t("通讯录为空"), systemImage: "person.2")
                } else {
                    List(filtered) { contact in
                        NavigationLink {
                            ContactDetailView(contact: contact, onCall: onCall, onMessage: onMessage)
                        } label: {
                            HStack(spacing: 12) {
                                InitialAvatar(name: contact.name, photoData: contact.photoData)
                                VStack(alignment: .leading) {
                                    Text(contact.name).font(.body.weight(.semibold))
                                    Text(contact.phones.first ?? "").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("\(L10n.t("通讯录")) · \(model.contacts.contacts.count)")
            .settingsToolbarButton(action: onSettings)
            .searchable(text: $search, prompt: L10n.t("搜索姓名或号码"))
            .task { await model.contacts.loadIfNeeded() }
            .refreshable { await model.contacts.requestAccessAndLoad() }
        }
    }
}

private struct ContactDetailView: View {
    let contact: ContactStore.Contact
    let onCall: (String) -> Void
    let onMessage: (String) -> Void

    var body: some View {
        List {
            Section {
                HStack {
                    Spacer()
                    VStack(spacing: 10) {
                        InitialAvatar(name: contact.name, photoData: contact.photoData, size: 82)
                        Text(contact.name).font(.title2.weight(.semibold))
                    }
                    Spacer()
                }
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(contact.phones, id: \.self) { phone in
                    HStack {
                        Text(phone)
                        Spacer()
                        Button { onMessage(phone) } label: { Image(systemName: "message.fill") }
                            .buttonStyle(.borderless)
                        Button { onCall(phone) } label: { Image(systemName: "phone.fill") }
                            .buttonStyle(.borderless).tint(.green)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(contact.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct InitialAvatar: View {
    let name: String
    var photoData: Data? = nil
    var size: CGFloat = 44

    var body: some View {
        Group {
            if let photoData, let image = UIImage(data: photoData) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Circle().fill(Color.green.opacity(0.18)).overlay {
                    Text(String(name.prefix(1))).font(.system(size: size * 0.4, weight: .semibold)).foregroundStyle(.green)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

extension View {
    /// 所有主页面复用同一个设置入口，避免设置页在不同页面里位置不一致。
    func settingsToolbarButton(action: @escaping () -> Void) -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: action) {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel(L10n.t("设置"))
            }
        }
    }
}

/// 新系统使用原生 ContentUnavailableView，iOS 16 保留等价回退。
private struct EmptyStateView: View {
    let title: String
    let systemImage: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    @ViewBuilder
    var body: some View {
        if #available(iOS 17.0, *) {
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
            } description: {
                Text(emptyStateDescription)
            } actions: {
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(.borderedProminent)
                }
            }
        } else {
            VStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 42))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(.borderedProminent)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        }
    }

    private var emptyStateDescription: String {
        switch systemImage {
        case "message": return "收到和发出的短信都会显示在这里。"
        case "phone.arrow.up.right": return "完成通话后，记录会显示在这里。"
        case "person.2": return "联系人会从系统通讯录同步。"
        default: return "完成连接或授权后即可使用。"
        }
    }
}

// MARK: - 通话覆盖层

struct ActiveCallView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let call: CallRecord
    @State private var showingKeypad = false

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var avatarSize: CGFloat { isCompact ? 88 : 112 }
    private var controlSize: CGFloat { isCompact ? 60 : 68 }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            LinearGradient(
                colors: [Color.green.opacity(0.13), Color.clear],
                startPoint: .top,
                endPoint: .center
            )
            .ignoresSafeArea()
            GeometryReader { geometry in
                // 小屏或大字体下允许纵向滚动，保证接听、静音和挂断始终可达。
                ScrollView {
                    VStack(spacing: isCompact ? 16 : 26) {
                Spacer()
                InitialAvatar(name: model.contacts.displayName(for: call.number), size: avatarSize)
                VStack(spacing: 6) {
                    Text(model.contacts.displayName(for: call.number))
                        .font(isCompact ? .title.weight(.semibold) : .largeTitle.weight(.semibold))
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                        .multilineTextAlignment(.center)
                    Text(statusText).font(.headline).foregroundStyle(.secondary)
                    if call.state == "active" {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(durationText(at: context.date)).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                    if model.audio.active, !model.audio.routeDescription.isEmpty {
                        Text(model.audio.routeDescription)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.75)
                            .multilineTextAlignment(.center)
                    }
                    if model.audio.active, !model.audio.diagnosticDescription.isEmpty {
                        Text(model.audio.diagnosticDescription)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.75)
                            .multilineTextAlignment(.center)
                    }
                    if model.audio.active, !model.audio.moduleDiagnosticDescription.isEmpty {
                        Text(model.audio.moduleDiagnosticDescription)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.75)
                            .multilineTextAlignment(.center)
                    }
                    if let audioError = model.audio.errorMessage, !audioError.isEmpty {
                        Text(audioError)
                            .font(.caption2)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .minimumScaleFactor(0.75)
                    }
                }

                if call.direction == "incoming" && ["incoming", "waiting"].contains(call.state) {
                    HStack(spacing: isCompact ? 54 : 70) {
                        CallCircleButton(title: L10n.t("拒接"), icon: "phone.down.fill", color: .red, size: controlSize) {
                            Task { await model.reject() }
                        }
                        CallCircleButton(title: L10n.t("接听"), icon: "phone.fill", color: .green, size: controlSize) {
                            Task { await model.answer() }
                        }
                    }
                } else {
                    HStack(spacing: isCompact ? 12 : 24) {
                        CallCircleButton(title: model.isMuted ? L10n.t("取消静音") : L10n.t("静音"), icon: model.isMuted ? "mic.slash.fill" : "mic.fill", color: model.isMuted ? .orange : .gray, size: controlSize) {
                            Task { await model.toggleMute() }
                        }
                        CallCircleButton(title: L10n.t("扬声器"), icon: model.isSpeakerEnabled ? "speaker.wave.2.fill" : "speaker.fill", color: model.isSpeakerEnabled ? .blue : .gray, size: controlSize) {
                            model.toggleSpeaker()
                        }
                        CallCircleButton(title: "键盘", icon: "circle.grid.3x3.fill", color: .gray, size: controlSize) {
                            showingKeypad = true
                        }
                        CallCircleButton(title: model.isRecording ? L10n.t("停止录音") : L10n.t("录音"), icon: "record.circle", color: model.isRecording ? .red : .gray, size: controlSize) {
                            Task { await model.toggleRecording() }
                        }
                    }
                    CallCircleButton(title: L10n.t("挂断"), icon: "phone.down.fill", color: .red, size: controlSize) {
                        Task { await model.hangup() }
                    }
                }
                        Spacer()
                    }
                    .frame(minHeight: geometry.size.height)
                    .frame(maxWidth: .infinity)
                    .padding()
                }
                .scrollIndicators(.hidden)
            }
        }
        .sheet(isPresented: $showingKeypad) { DTMFKeypadView() }
    }

    private var statusText: String {
        switch call.state {
        case "active": return L10n.t("通话中")
        case "incoming", "waiting": return L10n.t("等待接听")
        case "held": return "通话保持"
        default: return call.state
        }
    }

    private func durationText(at date: Date) -> String {
        let total = max(0, Int(date.timeIntervalSince(call.startedAt)))
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}

private struct CallCircleButton: View {
    let title: String
    let icon: String
    let color: Color
    var size: CGFloat = 68
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Circle().fill(color).frame(width: size, height: size).overlay {
                    Image(systemName: icon).font(.title2.weight(.semibold)).foregroundStyle(.white)
                }
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(minWidth: size)
        }
        .buttonStyle(.plain)
    }
}

private struct DTMFKeypadView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject private var model: AppModel
    private let rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["*", "0", "#"]]

    private var keySize: CGFloat { horizontalSizeClass == .compact ? 62 : 70 }

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                ForEach(rows, id: \.description) { row in
                    HStack(spacing: 24) {
                        ForEach(row, id: \.self) { digit in
                            Button {
                                Task { await model.sendDTMF(digit) }
                            } label: {
                                Text(digit)
                                    .font(.title)
                                    .frame(width: keySize, height: keySize)
                                    .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding()
            .navigationTitle("DTMF")
            .toolbar { Button(L10n.t("取消")) { dismiss() } }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}
