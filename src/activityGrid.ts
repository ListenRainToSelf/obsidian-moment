import { App } from "obsidian";
import type { MomentSettings } from "./settings";
import type { ActivityCell } from "./types";
import { parseMessages, splitFrontmatter, readDayContent } from "./dayFile";
import { dailyPath } from "./paths";
import { dateParts } from "./settings";

/**
 * 活跃度格点：对最近 N 天，读取当天文件统计动态条数，映射到 0-5 等级。
 * 颜色越深 = 当天动态越多。
 */
export class ActivityGrid {
	constructor(private days: number, private columns: number) {}

	async compute(
		app: App,
		settings: MomentSettings,
		fresh = false
	): Promise<ActivityCell[]> {
		const now = new Date();
		const today = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate()
		);

		const cells: ActivityCell[] = [];
		for (let i = this.days - 1; i >= 0; i--) {
			const d = new Date(today);
			d.setDate(today.getDate() - i);
			const dp = dateParts(d);
			const path = dailyPath(settings, d);
			const content = await readDayContent(app, path, fresh);
			let count = 0;
			if (content != null) {
				const { body } = splitFrontmatter(content);
				count = parseMessages(body).length;
			}
			cells.push({
				date: dp.dateKey,
				count,
				level: levelFor(count),
			});
		}
		return cells;
	}

	rows(): number {
		return Math.ceil(this.days / this.columns);
	}
}

/** 条数 → 等级 0-5 */
function levelFor(count: number): number {
	if (count <= 0) return 0;
	if (count === 1) return 1;
	if (count <= 2) return 2;
	if (count <= 3) return 3;
	if (count <= 5) return 4;
	return 5;
}