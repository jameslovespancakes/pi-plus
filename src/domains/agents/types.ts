
type State = "idle" | "thinking" | "tool";

export type Priority = "normal" | "urgent";

export interface Config { url: string; token: string; adminName?: string; }

export interface AgentInfo {
  sessionId: string; alias?: string; host: string; cwd: string; branch?: string;
  repo?: string; commit?: string; commitTime?: number; commitSubject?: string;
  model?: string; state: State; lastTool?: string; lastPrompt?: string; lastSeenAt?: number;
  key?: string; coordinator?: string | null; reports?: string[];
}

export interface ThreadInfo { id: string; kind: "direct" | "group"; title?: string; auto?: boolean; repoKey?: string; participantIds: string[]; participants: AgentInfo[]; lastMessage?: BoardMessage | null; }

export interface Coordination { key?: string; coordinator?: string | null; reports?: string[]; repoThread?: string; }

export interface BoardMessage { id: string; threadId: string; senderType: "user" | "agent"; senderId: string; senderAlias?: string; text: string; priority: Priority; createdAt: number; }

export interface GitInfo { branch?: string; repo?: string; commit?: string; commitTime?: number; commitSubject?: string; dirty?: boolean; }

export type Listener = (event: any) => void;
