export interface TranscriptInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  cwd?: string;
  customTitle?: string;
  firstPrompt?: string;
  tag?: string;
  createdAt?: number;
}

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

/** Session transcripts on disk. The SDK implementation lives below; tests use an in-memory one. */
export interface Transcripts {
  list(): Promise<TranscriptInfo[]>;
  info(id: string): Promise<TranscriptInfo | undefined>;
  messages(id: string): Promise<TranscriptMessage[]>;
  subagents(id: string): Promise<string[]>;
  subagentMessages(id: string, agentId: string): Promise<TranscriptMessage[]>;
  rename(id: string, title: string): Promise<void>;
  tag(id: string, tag: string | null): Promise<void>;
  remove(id: string): Promise<void>;
}

// The SDK is a large module. It is loaded on first use so an idle service stays small.
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

export const sdkTranscripts: Transcripts = {
  list: async () => (await sdk()).listSessions(),
  info: async (id) => (await sdk()).getSessionInfo(id),
  messages: async (id) => (await sdk()).getSessionMessages(id, { includeSystemMessages: false }),
  subagents: async (id) => (await sdk()).listSubagents(id),
  subagentMessages: async (id, agentId) => (await sdk()).getSubagentMessages(id, agentId),
  rename: async (id, title) => (await sdk()).renameSession(id, title),
  tag: async (id, tag) => (await sdk()).tagSession(id, tag),
  remove: async (id) => (await sdk()).deleteSession(id),
};
