import { AssistantState } from "@kodama/shared";

type Listener = (state: AssistantState) => void;

/**
 * 許可する遷移（IDLE→LISTENING→THINKING→SPEAKING→…）.
 * テキスト入力経路では IDLE→THINKING を直接通り, バージインでは
 * SPEAKING→LISTENING へ戻る.
 */
const ALLOWED: Record<AssistantState, AssistantState[]> = {
  IDLE: ["LISTENING", "THINKING"],
  LISTENING: ["THINKING", "IDLE", "SPEAKING"],
  THINKING: ["SPEAKING", "IDLE", "LISTENING"],
  SPEAKING: ["IDLE", "LISTENING", "THINKING"],
};

export class StateMachine {
  private current: AssistantState = AssistantState.IDLE;
  private listeners = new Set<Listener>();

  get state(): AssistantState {
    return this.current;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  transition(next: AssistantState): boolean {
    if (!ALLOWED[this.current].includes(next)) {
      return false;
    }
    this.current = next;
    for (const fn of this.listeners) fn(next);
    return true;
  }
}
