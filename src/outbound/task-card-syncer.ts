// TaskCardSyncer: Outbound coordinator for live Task & Goal board cards (ADR-TaskCard).
// Manages single-card in-place updates, 1500ms trailing-edge debounce, and sequence integrity.
// Pure outbound layer: depends only on CardKitApi and presentation layer builders.

import { randomUUID } from "node:crypto";
import type { GoalSnapshotState, TaskCardState, TodoItemState } from "../common/types.ts";
import { buildTaskBoardCard } from "../presentation/task-cards.ts";
import type { CardKitApi } from "./cardkit-stream.ts";

export interface TaskCardSyncerOptions {
	api: CardKitApi;
	/** Map sessionKey to route/chatId for delivery. */
	routeFor?: (sessionKey: string) => { chatId: string } | undefined;
	deliverCard?: (params: { chatId: string; cardId: string }) => Promise<unknown>;
	/** Debounce delay in ms (default 1500ms to stay within Feishu chat rate limits). */
	debounceMs?: number;
	now?: () => number;
	onError?: (err: unknown) => void;
}

export interface TaskCardSyncer {
	/** Update or initialize the goal state for a session. */
	updateGoal(sessionKey: string, goal: GoalSnapshotState, workspacePath?: string): Promise<void>;
	/** Update the todo item list snapshot for a session. */
	updateTodos(sessionKey: string, todos: TodoItemState[], workspacePath?: string): Promise<void>;
	/** Toggle folding state of the task list for a session. */
	toggleFold(sessionKey: string, isFolded?: boolean): Promise<void>;
	/** Get current task card state for a session. */
	getState(sessionKey: string): TaskCardState | undefined;
	/** Settle/flush any pending updates for a session. */
	flush(sessionKey: string): Promise<void>;
	/** Clear and dispose card tracking for a session. */
	disposeSession(sessionKey: string): void;
}

export function createTaskCardSyncer(opts: TaskCardSyncerOptions): TaskCardSyncer {
	const states = new Map<string, TaskCardState>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const inFlight = new Set<string>();
	const debounceMs = opts.debounceMs ?? 1500;
	const now = opts.now ?? Date.now;

	const ensureState = (sessionKey: string, workspacePath?: string): TaskCardState => {
		let st = states.get(sessionKey);
		if (!st) {
			st = {
				sessionKey,
				sequence: 0,
				todos: [],
				workspacePath,
				isFolded: true,
				lastUpdatedAt: now(),
			};
			states.set(sessionKey, st);
		}
		if (workspacePath) st.workspacePath = workspacePath;
		return st;
	};

	const extractCardId = (
		res: { card_id?: string; data?: { card_id?: string } } | undefined,
	): string | undefined => res?.card_id ?? res?.data?.card_id;

	async function pushCard(sessionKey: string): Promise<void> {
		const st = states.get(sessionKey);
		if (!st) return;

		// Cancel pending timer
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}

		if (inFlight.has(sessionKey)) {
			// Reschedule flush if already in flight
			scheduleDebounce(sessionKey);
			return;
		}

		inFlight.add(sessionKey);
		st.lastUpdatedAt = now();

		try {
			const cardPayload = buildTaskBoardCard(st);
			const cardJsonStr = JSON.stringify(cardPayload);

			if (!st.cardEntityId) {
				// First creation: create entity + deliver
				const createRes = await opts.api.createCard({
					type: "card_json",
					data: cardJsonStr,
				});
				const cardId = extractCardId(createRes);
				if (!cardId) throw new Error("TaskCard create returned no card_id");
				st.cardEntityId = cardId;
				st.sequence = 1;

				if (opts.deliverCard && opts.routeFor) {
					const route = opts.routeFor(sessionKey);
					if (route?.chatId) {
						await opts.deliverCard({ chatId: route.chatId, cardId });
					}
				} else {
					await opts.api.deliverCard(cardId);
				}
			} else {
				// In-place update
				st.sequence += 1;
				await opts.api.updateCard(st.cardEntityId, {
					card: {
						type: "card_json",
						data: cardJsonStr,
					},
					sequence: st.sequence,
					uuid: randomUUID(),
				});
			}
		} catch (err) {
			opts.onError?.(err);
		} finally {
			inFlight.delete(sessionKey);
		}
	}


	function scheduleDebounce(sessionKey: string): void {
		if (timers.has(sessionKey)) return;
		const timer = setTimeout(() => {
			timers.delete(sessionKey);
			void pushCard(sessionKey);
		}, debounceMs);
		timers.set(sessionKey, timer);
	}

	async function updateGoal(sessionKey: string, goal: GoalSnapshotState, workspacePath?: string): Promise<void> {
		const st = ensureState(sessionKey, workspacePath);
		st.goal = goal;
		if (goal.phase === "complete" || !st.cardEntityId) {
			// Immediate push for creation or completion
			await pushCard(sessionKey);
		} else {
			scheduleDebounce(sessionKey);
		}
	}

	async function updateTodos(sessionKey: string, todos: TodoItemState[], workspacePath?: string): Promise<void> {
		const st = ensureState(sessionKey, workspacePath);
		st.todos = todos;
		const allCompleted = todos.length > 0 && todos.every((t) => t.status === "completed");
		if (!st.cardEntityId || allCompleted) {
			await pushCard(sessionKey);
		} else {
			scheduleDebounce(sessionKey);
		}
	}

	async function toggleFold(sessionKey: string, isFolded?: boolean): Promise<void> {
		const st = states.get(sessionKey);
		if (!st) return;
		st.isFolded = isFolded ?? !st.isFolded;
		await pushCard(sessionKey);
	}

	function getState(sessionKey: string): TaskCardState | undefined {
		return states.get(sessionKey);
	}

	async function flush(sessionKey: string): Promise<void> {
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		await pushCard(sessionKey);
	}

	function disposeSession(sessionKey: string): void {
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		states.delete(sessionKey);
		inFlight.delete(sessionKey);
	}

	return {
		updateGoal,
		updateTodos,
		toggleFold,
		getState,
		flush,
		disposeSession,
	};
}
