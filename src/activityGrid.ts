import { DayFileStore } from "./dayFile";
import type { ActivityCell } from "./types";
import { dateParts } from "./settings";

/**
 * 活跃度格点：对最近 N 天，读取当天文件统计动态条数，映射到 0-5 等级。
 * 颜色越深 = 当天动态越多。
 *
 * 读取走共享的 DayFileStore：同一次刷新中这些天往往也被信息流 / 心情统计读到，
 * 由 store 的并发去重与 mtime 缓存合并成一次读盘 + 一次解析。
 */
export class ActivityGrid {
	constructor(private days: number) {}

	async compute(
		store: DayFileStore,
		fresh = false
	): Promise<ActivityCell[]> {
		const now = new Date();
		const today = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate()
		);

		const tasks: Promise<ActivityCell>[] = [];
		for (let i = this.days - 1; i >= 0; i--) {
			const d = new Date(today);
			d.setDate(today.getDate() - i);
			tasks.push(
				store.readDay(d, fresh).then((day) => {
					const count = day ? day.messages.length : 0;
					return {
						date: dateParts(d).dateKey,
						count,
						level: levelFor(count),
					};
				})
			);
		}
		// Promise.all 保持数组顺序（旧 → 新），与原来的串行循环一致
		return Promise.all(tasks);
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
