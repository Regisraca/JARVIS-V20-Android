import * as direct from './gemini'
import type { AskHandlers, Msg, BrainDiagnostic } from './gemini'

/**
 * JARVIS uses the secure server-side provider layer; the Android bridge remains separate.
 *
 * The Android phone bridge is deliberately separate: src/lib/phone.ts talks
 * to the tiny Termux server on 127.0.0.1:8787 when Gemini emits a permitted
 * [[ACAO ...]] action. Claude Code is not required.
 */
export type { AskHandlers, Msg, BrainDiagnostic }
export type ConnectionState = 'open' | 'lost' | 'reconnected'

export const usingBridge = false

export async function ask(
  prompt: string,
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[]; diagnostic: BrainDiagnostic | null }> {
  return direct.ask([...history, { role: 'user', content: prompt }], handlers)
}

export async function warm(): Promise<void> {
  await direct.warm()
}

export function watchServers(_fn: (servers: string[]) => void): void {}
export function watchPanels(_fn: (panel: any) => void): void {}
export function watchBlades(_fn: (blade: any) => void): void {}
export function watchUi(_fn: (op: string, args: any) => void): void {}
export function watchCapture(
  _fn: (req: any) => Promise<any>,
): void {}

export function cancel(): void {
  direct.cancel()
}
export function interrupt(): void {
  cancel()
}
export function isConnected(): boolean {
  return true
}
export function watchConnection(_fn: (state: ConnectionState) => void): void {}
export function connectedLabels(): string[] {
  return direct.connectedLabels()
}
