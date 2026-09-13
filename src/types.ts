/** 共享类型定义 */

/** 一条动态（单日文件内的一个 ## 块） */
export interface MomentMessage {
	/** 12 小时制时间，如 "09:08" / "21:04" */
	time: string;
	/** 心情标签文本 */
	mood?: string;
	/** 正文 */
	text: string;
	/** 配图文件名数组（仅附件名） */
	images: string[];
}

/** 一天的日记内容 */
export interface MomentDay {
	/** 日期键 YYYY-M-D，如 "2026-9-10" */
	date: string;
	/** 当天心情数组（frontmatter mood） */
	moods: string[];
	/** 当天名言 */
	quote?: string;
	/** 动态列表（倒序展示时反转） */
	messages: MomentMessage[];
	/** 当天的附件缩略图（用于全览） */
	thumbs: string[];
}

/** 全览聚合档位 */
export type AggregationLevel = "day" | "week" | "month" | "year";

/** 活跃度格点的一条 */
export interface ActivityCell {
	date: string;
	/** 动态条数 / 活跃度等级 0-5 */
	level: number;
	count: number;
}