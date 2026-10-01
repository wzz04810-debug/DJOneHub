import type { FirmwareRelease } from "./catalog";

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function releaseCard(release: FirmwareRelease, latest: boolean, onSelect: (release: FirmwareRelease, bytes: Uint8Array) => void, fetcher: typeof fetch): HTMLElement {
  const article = document.createElement("article");
  article.className = "firmware-release";

  const marker = document.createElement("span");
  marker.className = "release-marker";
  marker.setAttribute("aria-hidden", "true");

  const identity = document.createElement("div");
  identity.className = "release-identity";
  const heading = document.createElement("h3");
  heading.textContent = `QDC507 ${release.version}`;
  const build = document.createElement("p");
  build.textContent = `TestFlight build ${release.testflightBuild}${latest ? " · 最新上传" : ""}`;
  identity.append(heading, build);

  const facts = document.createElement("dl");
  facts.className = "release-facts";
  const values: ReadonlyArray<readonly [string, string]> = [["上传日期", formatDate(release.uploadedAt)], ["文件大小", formatBytes(release.size)], ["SHA-256", release.sha256 ? `${release.sha256.slice(0, 12)}…` : "校验值暂不可用"]];
  for (const [label, value] of values) {
    const group = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd"); description.textContent = value;
    if (label === "SHA-256" && release.sha256) description.title = release.sha256;
    group.append(term, description); facts.append(group);
  }

  const actions = document.createElement("div");
  actions.className = "release-actions";
  const select = document.createElement("button");
  select.className = "select-firmware";
  select.type = "button";
  select.textContent = "用于刷写";
  select.addEventListener("click", async () => {
    select.disabled = true;
    select.textContent = "正在安全载入…";
    try {
      const response = await fetcher("/api/firmware-package", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-DJOneHub-Flash": "1" },
        body: JSON.stringify({ id: release.id }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== release.size || (release.sha256 && await sha256(bytes) !== release.sha256)) throw new Error("firmware integrity mismatch");
      onSelect(release, bytes);
      select.textContent = "已选用于刷写";
      article.classList.add("selected");
    } catch {
      select.disabled = false;
      select.textContent = "载入失败，重试";
    }
  });
  actions.append(select);
  if (release.sha256) {
    const copy = document.createElement("button");
    copy.className = "copy-checksum";
    copy.type = "button";
    copy.textContent = "复制校验值";
    copy.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(release.sha256 ?? "");
      copy.textContent = "已复制";
      window.setTimeout(() => { copy.textContent = "复制校验值"; }, 1600);
    });
    actions.append(copy);
  }

  article.append(marker, identity, facts, actions);
  return article;
}

export async function mountFirmwareLibrary(container: HTMLElement, onSelect: (release: FirmwareRelease, bytes: Uint8Array) => void, fetcher: typeof fetch = fetch): Promise<void> {
  container.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "library-state";
  loading.textContent = "正在读取固件版本…";
  container.append(loading);
  try {
    const catalogURL = `/api/firmware?refresh=${Date.now()}`;
    const response = await fetcher(catalogURL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { releases?: FirmwareRelease[] };
    const releases = Array.isArray(payload.releases) ? payload.releases : [];
    container.replaceChildren();
    if (releases.length === 0) {
      const empty = document.createElement("p");
      empty.className = "library-state";
      empty.textContent = "还没有已发布的固件包。首次上传后，版本会自动出现在这里。";
      container.append(empty);
      return;
    }
    releases.forEach((release, index) => container.append(releaseCard(release, index === 0, onSelect, fetcher)));
  } catch {
    loading.textContent = "暂时无法读取固件版本，请稍后刷新页面。";
    loading.className = "library-state error-copy";
  }
}
