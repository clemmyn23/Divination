// The shared contract. Every source, stage and command uses these names.

export type Transport = "api" | "ics" | "inbox";

export interface SlackConversationConfig {
  id: string;
  name: string;
  dm?: boolean;
}

export interface SlackGroupConfig {
  name: string;
  kind: "digest" | "alerts";
  conversations: SlackConversationConfig[];
}

export interface RiskPath {
  pattern: string;
  label: string;
  weight: number;
}

export interface Config {
  me: { name: string; email: string; timezone: string };
  sources: string[];
  tick: { minutes: number; days: number[]; start: string; end: string };
  staleAfterMinutes: number;
  /** The same limit for a source fed by hand through its inbox, which is read far less often. */
  inboxStaleAfterMinutes: number;
  /** PRs and other waiting things older than this are folded into "stale tasks". 0 never folds. */
  hideOlderThanDays: number;
  enrich: { maxBudgetUsd: number };
  server: { port: number };
  github: {
    transport: Transport;
    host: string;
    rotationTeam: string;
    /** GitHub usernames of the review crew's members. A PR one of them raises may bypass the crew's review. */
    crewMembers: string[];
    review: { model: string };
    rank: { riskPaths: RiskPath[]; docsPattern: string; quickWinMaxLines: number; largeLines: number };
    slackSignal: { channelId: string; skipReactions: string[] };
  };
  slack: {
    transport: Transport;
    workspaceUrl: string;
    /** The workspace's team id (`T…`). When set, Slack links open the Slack app instead of the browser. */
    teamId: string;
    userId: string;
    windowHours: number;
    /** Authors (names, or bot ids) whose threads are left out when nobody else wrote in them. */
    muteAuthors: string[];
    groups: SlackGroupConfig[];
    dynamic: { postedWithinDays: number; exclude: string[] };
    alerts: { firing: string; resolved: string };
    summary: { model: string; minMessages: number };
  };
  calendar: { transport: Transport; dayStart: string; dayEnd: string };
}

/** Every location the tool writes to. All of them live under `<root>/out`. */
export interface Paths {
  out: string;
  data(id: string): string;
  inbox(id: string): string;
  cache(...parts: string[]): string;
  site: string;
  logs: string;
  lock: string;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Http {
  json<T>(url: string, init?: HttpInit): Promise<{ data: T; headers: Headers }>;
  /** The body as it came, for answers that are not JSON (a calendar file). */
  text(url: string, init?: HttpInit): Promise<{ data: string; headers: Headers }>;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: {
    input?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    /** Called with each piece of output as it arrives. The whole output is still returned at the end. */
    onStdout?: (chunk: string) => void;
  },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Secrets {
  get(name: string): Promise<string | undefined>;
}

export type Tint = "butter" | "blush" | "mint" | "lilac";

export interface Envelope<T> {
  source: string;
  ok: boolean;
  error?: string;
  /** When `data` was last collected successfully. 0 means never. */
  collectedAt: number;
  /** When collection was last tried, successful or not. */
  attemptedAt: number;
  data: T | null;
}

export interface AttentionItem {
  key: string;
  title: string;
  reason: string;
  url?: string;
  /** When this started waiting, in epoch ms. Old items are folded away; undated ones never are. */
  at?: number;
  /** The key that marks this item's line as done. Without one the item cannot be ticked off. */
  doneKey?: string;
}

export interface Panel {
  id: string;
  title: string;
  tint: Tint;
  /** How much room the panel asks for. A short panel shares a column with another; the default is tall. */
  size?: "short" | "tall";
  /** Already-escaped HTML. Sources escape their own content. */
  html: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface EnrichItem {
  key: string;
  hash: string;
  input: unknown;
}

export interface View {
  now: number;
  config: Config;
  /** enricher id -> item key -> cached output */
  enrich: Record<string, Record<string, unknown>>;
  /** Lines ticked off by hand: done key -> when. See `src/core/done.ts`. */
  done: Record<string, number>;
}

export interface Enricher<TData> {
  id: string;
  items(data: TData, ctx: Context): EnrichItem[];
  /** item key -> output; omit a key to skip it */
  run(items: EnrichItem[], ctx: Context): Promise<Record<string, unknown>>;
}

export interface Source<TData> {
  id: string;
  title: string;
  doctor(ctx: Context): Promise<Check[]>;
  collect(ctx: Context): Promise<TData>;
  /**
   * Turn what was dropped in this source's inbox file into its data. Without this, the
   * dropped file must already be the data. Throw to refuse a file in the wrong shape.
   */
  fromInbox?(dropped: unknown, ctx: Context): TData;
  /** Problems with the data; empty means valid. */
  validate(data: unknown): string[];
  attention(data: TData, view: View): AttentionItem[];
  panels(data: TData, view: View): Panel[];
  enrichers?: Enricher<TData>[];
}

export interface Context {
  root: string;
  config: Config;
  paths: Paths;
  now(): number;
  http: Http;
  exec: Exec;
  secrets: Secrets;
  log(event: string, fields?: object): void;
}
