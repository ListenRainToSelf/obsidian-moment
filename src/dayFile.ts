import { App, TFile, normalizePath, Notice } from "obsidian";
import type { MomentSettings } from "./settings";
import type { MomentDay, MomentMessage } from "./types";
import {
	dailyPath,
	monthBodyDir,
	monthAttachmentDir,
	attachmentRoot,
} from "./paths";
import { dateParts } from "./settings";

/**
 * 日期文件的读 / 写 / 追加。
 *
 * 单日文件格式（v0.2.2 起）：
 * ```md
 * ---
 * mood: ["元气","有灵感"]
 * quote: 万物皆有裂缝
 * updated: 2026-09-10T21:04:00
 * ---

 * #此刻

 * ## 21:04
 * 今天下午那杯桂花拿铁真的很绝。

 * ![2026-9-10-21-04-00.jpg](../../附件/2026-9/2026-9-10-21-04-00.jpg)

 * > 心情：满足
 * ```
 * 说明：
 * - `#此刻` = 仓库标签（Obsidian tag，用于把全部日记归在同一标签下）
 * - 图片直接用 markdown 图片链接 `![名](相对路径)`，可在编辑/预览中直接渲染
 * - 心情用行首块引用 `> 心情：ｘ`，比旧的 `- 心情：ｘ` 更不易与正文误识别
 * - 同时兼容解析旧格式（`## 21:04 · 图.jpg` 头部 + `- 心情：ｘ` 行尾）
 */

const FM_START = "---";
/** 仓库标签（写入每日文件正文顶部，便于在 Obsidian 标签栏归组） */
export const DAY_TAG = "此刻";

/** 渲染一条动态为 markdown 文本 */
export function renderMessage(
	settings: MomentSettings,
	date: Date,
	msg: MomentMessage
): string {
	const lines: string[] = [];
	lines.push(`## ${msg.time}`);
	if (msg.text) {
		for (const line of msg.text.split("\n")) {
			lines.push(line);
		}
	}
	// 图片：markdown 图片链接（相对本笔记目录可达）
	for (const name of msg.images) {
		lines.push(`![${name}](${mdImageRel(settings, date, name)})`);
	}
	if (msg.mood) {
		lines.push(`> 心情：${msg.mood}`);
	}
	lines.push(""); // 块间空行
	return lines.join("\n");
}

/** 计算某日笔记内图片的 markdown 相对链接路径 */
function mdImageRel(
	settings: MomentSettings,
	date: Date,
	name: string
): string {
	const p = dateParts(date);
	const noteDir = monthBodyDir(settings, p.monthDir);
	const imgPath = normalizePath(
		`${monthAttachmentDir(settings, p.monthDir)}/${name}`
	);
	return relPath(noteDir, imgPath);
}

/** 通用相对路径（POSIX）：从 aDir 走到 bPath */
function relPath(aDir: string, bPath: string): string {
	const a = aDir.split("/").filter(Boolean);
	const b = bPath.split("/").filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const up = new Array(a.length - i).fill("..");
	return [...up, ...b.slice(i)].join("/") || ".";
}

/** 从路径中取文件名（兼容 / 与 \） */
function basename(p: string): string {
	return p.split(/[\\/]/).pop() || p;
}

/** 生成新建日文件的最小 frontmatter + 空正文 + 仓库标签 */
export function renderFreshFile(
	settings: MomentSettings,
	date: Date
): string {
	const quote = randomQuote(settings);
	const lines = [FM_START, "mood: []"];
	if (quote) lines.push(`quote: ${quote}`);
	lines.push(`updated: ${toISO(date)}`);
	lines.push(FM_START);
	lines.push("");
	lines.push(`#${DAY_TAG}`);
	lines.push("");
	return lines.join("\n");
}

function randomQuote(settings: MomentSettings): string | undefined {
	const qs = (settings.quotes || []).filter((q) => q.trim());
	if (!qs.length) return;
	return qs[Math.floor(Math.random() * qs.length)];
}

function toISO(d: Date): string {
	return d.toISOString();
}

export class DayFileStore {
	constructor(private app: App, private settings: MomentSettings) {}

	/** 某天文件是否存在 */
	hasDay(date: Date): boolean {
		const path = dailyPath(this.settings, date);
		return !!this.app.vault.getAbstractFileByPath(path);
	}

	/** 读取某天；不存在或解析失败返回 null */
	async readDay(date: Date): Promise<MomentDay | null> {
		const p = dateParts(date);
		const path = dailyPath(this.settings, date);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		let content: string;
		try {
			content = await this.app.vault.cachedRead(file);
		} catch {
			return null;
		}
		const { fm, body } = splitFrontmatter(content);
		const messages = parseMessages(body);
		const thumbs = collectThumbs(messages);
		return {
			date: p.dateKey,
			moods: fm.mood || [],
			quote: fm.quote || undefined,
			messages,
			thumbs,
		};
	}

	/** 追加一条动态到今天（不存在则创建） */
	async append(
		date: Date,
		msg: MomentMessage
	): Promise<{ path: string }> {
		const path = dailyPath(this.settings, date);
		let file = this.app.vault.getAbstractFileByPath(path);

		if (!(file instanceof TFile)) {
			// 确保目录存在
			const dp = dateParts(date);
			await this.ensureDir(monthBodyDir(this.settings, dp.monthDir));
			file = await this.app.vault.create(
				path,
				renderFreshFile(this.settings, date)
			);
		}

		const current = await this.app.vault.read(file as TFile);
		// 统一 updated 时间戳
		const upd = updateFrontmatterTime(current, toISO(date));
		const appended = upd.endsWith("\n\n")
			? upd
			: upd.replace(/\s*$/, "\n\n");
		const next = appended + renderMessage(this.settings, date, msg);
		await this.app.vault.modify(file as TFile, next);
		return { path };
	}

	/** 移除某天的某一条动态（按内容比对定位，保留 frontmatter、仓库标签及其它块）。返回是否删除成功 */
	async removeMessage(date: Date, msg: MomentMessage): Promise<boolean> {
		const path = dailyPath(this.settings, date);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;
		const content = await this.app.vault.read(file);
		// 以 `\n## ` 为块边界拆分；part[0] 为 frontmatter + 仓库标签等前置内容
		const parts = content.split(/\n## /);
		if (parts.length < 2) return false;
		const kept = [parts[0]];
		let removed = false;
		for (let i = 1; i < parts.length; i++) {
			const parsed = parseMessages("## " + parts[i]);
			if (parsed.length === 1 && sameMessage(parsed[0], msg)) {
				removed = true;
				continue;
			}
			kept.push(parts[i]);
		}
		if (!removed) return false;
		await this.app.vault.modify(file, kept.join("\n## "));
		return true;
	}

	/** 保证目录存在（递归创建） */
	async ensureDir(path: string): Promise<void> {
		await this.app.vault.createFolder(path).catch((e) => {
			if (!String(e).includes("already exists")) throw e;
		});
	}

	/** 附件目录（确保存在后返回） */
	async ensureAttachmentRoot(): Promise<string> {
		const root = attachmentRoot(this.settings);
		await this.ensureDir(root);
		if (this.settings.rootPath) {
			await this.ensureDir(this.settings.rootPath);
		}
		return root;
	}

	/** 打开视图时按设置创建根目录与附件目录（若未存在） */
	async ensureRoot(): Promise<void> {
		if (this.settings.rootPath) {
			await this.ensureDir(this.settings.rootPath);
			await this.ensureDir(attachmentRoot(this.settings));
		}
	}
}

/* ---------------- 解析辅助 ---------------- */

/** 拆分 frontmatter 与 body */
export function splitFrontmatter(content: string): {
	fm: Record<string, any>;
	body: string;
} {
	const fm: Record<string, any> = {};
	if (content.startsWith(FM_START)) {
		const end = content.indexOf("\n" + FM_START, 3);
		if (end !== -1) {
			const head = content.slice(3, end).trim();
			body: for (const line of head.split("\n")) {
				const m = line.match(/^([\w-]+):\s*(.*)$/);
				if (!m) continue;
				const key = m[1];
				let val: any = m[2].trim();
				if (val.startsWith("[") && val.endsWith("]")) {
						val = (val.slice(1, -1).match(/"([^"]*)"/g) || []).map(
							(s: string) => s.slice(1, -1)
						);
				}
				fm[key] = val;
			}
			const rest = content.slice(end + 4);
			return { fm, body: rest };
		}
	}
	return { fm, body: content };
}

/** 从 body 解析消息列表（按 ## 时间 分块）。兼容新旧两种格式 */
export function parseMessages(body: string): MomentMessage[] {
	const blocks = body.split(/\n## /);
	const list: MomentMessage[] = [];

	for (let i = 0; i < blocks.length; i++) {
		const raw = i === 0 ? blocks[i] : "## " + blocks[i];
		const bodyText = raw.replace(/^\s*## /, "").trim();
		if (!bodyText) continue;

		const headEnd = bodyText.indexOf("\n");
		const headLine = (headEnd === -1 ? bodyText : bodyText.slice(0, headEnd)).trim();
		const restRaw = headEnd === -1 ? "" : bodyText.slice(headEnd + 1);

		// 头部：`21:04` 时间（必需）
		const timeM = headLine.match(/^(\d{1,2}:\d{2})/);
		if (!timeM) continue;
		const time = timeM[1];

		// 旧格式：头部 ` · image.jpg` 直接挂载的图片名
		const headImages = (headLine.split("·").slice(1) as string[])
			.map((s) => s.trim())
			.filter((s) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(s));

		// 心情：新格式行首块引用 `> 心情：ｘ`；旧格式行尾 `- 心情：ｘ`
		let images = headImages;
		let textBlock = restRaw.trim();
		let mood: string | undefined;
		const moodM = textBlock.match(/^>\s*心情[:：]\s*(.+)$/m);
		if (moodM) {
			mood = moodM[1].trim();
			textBlock = textBlock
				.split("\n")
				.filter((l) => l !== moodM[0])
				.join("\n")
				.trim();
		} else {
			const legacyMood = textBlock.match(/- 心情：\s*(.+)\s*$/);
			if (legacyMood) {
				mood = legacyMood[1].trim();
				textBlock = textBlock.slice(0, legacyMood.index).trim();
			}
		}

		// 图片：markdown 图片链接 `![名](路径)` / 嵌入 `![[路径]]`，取文件名
		const extracted: string[] = [];
		const mdLink = /!\[[^\]]*\]\(([^)]+?)\)/g;
		let mm: RegExpExecArray | null;
		while ((mm = mdLink.exec(textBlock))) {
			const b = basename(mm[1].trim());
			if (b && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(b))
				extracted.push(b);
		}
		const wikilink = /!\[\[([^\]]+)\]\]/g;
		while ((mm = wikilink.exec(textBlock))) {
			const b = basename(mm[1].trim());
			if (b && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(b))
				extracted.push(b);
		}
		if (extracted.length) images = extracted;

		// 从正文中剔除整行的 markdown 图片引用，避免在信息流中显示原始语法
		textBlock = textBlock
			.split("\n")
			.filter(
				(line) =>
					!/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line) &&
					!/^\s*!\[\[[^\]]+\]\]\s*$/.test(line)
			)
			.join("\n")
			.trim();

		list.push({ time, mood, text: textBlock, images });
	}
	return list;
}

/** 按内容比对两条动态是否相同 */
function sameMessage(a: MomentMessage, b: MomentMessage): boolean {
	return (
		a.time === b.time &&
		a.mood === b.mood &&
		a.text === b.text &&
		a.images.length === b.images.length &&
		a.images.every((v, i) => v === b.images[i])
	);
}

function collectThumbs(msgs: MomentMessage[]): string[] {
	const set = new Set<string>();
	for (const m of msgs) for (const img of m.images) set.add(img);
	return [...set];
}

/** 刷新文件末尾的 updated 时间戳 */
export function updateFrontmatterTime(content: string, iso: string): string {
	if (content.startsWith(FM_START)) {
		return content
			.split("\n")
			.map((line) =>
				/^updated:/.test(line) ? `updated: ${iso}` : line
			)
			.join("\n");
	}
	return content;
}

/** 安全包装 notice */
export function momentNotice(msg: string, timeout?: number) {
	new Notice(msg, timeout);
}