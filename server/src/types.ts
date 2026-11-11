// Малките части от типовете на Cloudflare, които ползваме (без цял пакет с типове).
export interface D1Result<T = unknown> { results: T[]; meta: { changes: number; last_row_id: number } }
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<D1Result[]> }
export interface Stub { fetch(url: string | Request, init?: RequestInit): Promise<Response> }
export interface NS { idFromName(name: string): unknown; get(id: unknown): Stub }
export interface Env { DB: D1; ROOMS: NS; LOBBY: NS; IP_SALT?: string; DEV_FORWARDED?: string }
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>;
}
export interface DOState { id: { toString(): string }; storage: Storage; blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> }
