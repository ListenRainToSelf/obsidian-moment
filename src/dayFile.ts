import { App, TFile, normalizePath, Notice } from "obsidian";
import type { MomentSettings } from "./settings";
import type { MomentDay, MomentMessage } from "./types";
import { dailyPath, monthBodyDir, attachmentRoot } from "./paths";
import { dateParts } from "./settings";

/**
 * 日期文件的读 / 写 / 追加。
 *
 * 单日文件格式：
 * ```md
 * ---
 * mood: ["元气","有灵感"]
 * quote: 万物皆有裂缝
 * updated: 2026-09-10T21:04:00
 * ---
 *
 * ## 21:04 · 2026-9-10-18:58:30.jpg
 * 今天下午那杯桂花拿铁真的很绝。
 * - 心情：满足
 * ```
 */

const FM_START = "---";
/** 渲染一条动态为 markdown 文本 */
export function renderMessage(msg: MomentMessage): string {
	const lines: string[] = [];
	let head = `## ${msg.time}`;
	if (msg.images.length) {
		head += ` · ${msg.images.join(" · ")}`;
	}
	lines.push(head);
	if (msg.text) {
		for (const line of msg.text.split("\n")) {
			lines.push(line);
		}
	}
	if (msg.mood) {
		lines.push(`- 心情：${msg.mood}`);
	}
	lines.push(""); // 块间空行
	return lines.join("\n");
}

/** 生成新建日文件的最小 frontmatter + 空正文 */
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
		const next = appended + renderMessage(msg);
		await this.app.vault.modify(file as TFile, next);
		return { path };
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

/** 从 body 解析消息列表（按 ## 时间 分块） */
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

		// 头部：`21:04` + 可选 ` · image.jpg`
		const timeM = headLine.match(/^(\d{1,2}:\d{2})/);
		if (!timeM) continue;
		const time = timeM[1];
		const images = (headLine.split("·").slice(1) as string[])
			.map((s) => s.trim())
			.filter((s) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(s));

		// 去掉末尾 `- 心情：xxx`
		let textBlock = restRaw.trim();
		let mood: string | undefined;
		const moodM = textBlock.match(/- 心情：\s*(.+)\s*$/);
		if (moodM) {
			mood = moodM[1].trim();
			textBlock = textBlock.slice(0, moodM.index).trim();
		}

		list.push({ time, mood, text: textBlock, images });
	}
	return list;
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