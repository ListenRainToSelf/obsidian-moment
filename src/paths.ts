import { normalizePath } from "obsidian";
import type { MomentSettings } from "./settings";
import { dateParts } from "./settings";

/**
 * 路径规划：正文按月 / 附件独立目录 / 背景固定名 img.jpg
 * 根目录视为库内相对路径（normalizePath 也兼容 "vault/子目录" 写法）。
 */

/** 计算正文根（rootPath 为空则用库根） */
export function bodyRoot(settings: MomentSettings): string {
	return normalizePath(settings.rootPath || "");
}

/** 附件目录根 */
export function attachmentRoot(settings: MomentSettings): string {
	const root = bodyRoot(settings);
	if (!root) return normalizePath(settings.attachmentDir || "附件");
	return normalizePath(`${root}/${settings.attachmentDir || "附件"}`);
}

/** 某日正文文件路径，如 "2026-9/2026-9-10.md" */
export function dailyPath(settings: MomentSettings, date: Date): string {
	const p = dateParts(date);
	const root = bodyRoot(settings);
	const rel = normalizePath(`${p.monthDir}/${p.dateKey}.md`);
	return root ? `${root}/${rel}` : rel;
}

/** 整月所有正文的目录路径，如 "2026-9" */
export function monthBodyDir(settings: MomentSettings, monthDir: string): string {
	const root = bodyRoot(settings);
	return root ? normalizePath(`${root}/${monthDir}`) : normalizePath(monthDir);
}

/** 整月附件目录路径 */
export function monthAttachmentDir(
	settings: MomentSettings,
	monthDir: string
): string {
	return normalizePath(
		`${attachmentRoot(settings)}/${monthDir}`
	);
}

/** 背景路径：附件目录内名为 coverName 的文件 */
export function coverPath(settings: MomentSettings): string {
	return normalizePath(`${attachmentRoot(settings)}/${settings.coverName || "img.jpg"}`);
}

/** 按时间命名附件（当日落本月附件夹）：YYYY-M-D-HH-MM-SS[-后缀].ext
 *  后缀用于区分同一秒内多选的多张图片，避免文件名冲突 */
export function attachmentPath(
	settings: MomentSettings,
	date: Date,
	ext: string,
	suffix = ""
): string {
	const p = dateParts(date);
	const hh = String(date.getHours()).padStart(2, "0");
	const mi = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	const name = `${p.dateKey}-${hh}-${mi}-${ss}${suffix}${ext}`;
	return normalizePath(
		`${attachmentRoot(settings)}/${p.monthDir}/${name}`
	);
}