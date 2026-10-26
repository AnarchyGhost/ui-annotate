import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DELIVERY_OFF,
  type Annotation,
  type AnnotationPatch,
  type AnnotationStatus,
  type Delivery,
  type ParsedAnnotationInput,
  type ProjectRootSource,
  type ServerEvent,
  type Session,
  type SessionSummary,
  type ThreadKind,
  type ThreadMessage,
  type ThreadRole,
} from "@ui-annotate/protocol";
import { applyTransition, deliveryOf, replacesRoot, sessionKey, transitionForStatus, type Transition } from "./domain.js";

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export interface SessionUpsert {
  url: string;
  title: string;
  includeHash: boolean;
  projectRoot: string | null;
}

export interface AnnotationQuery {
  sessionId?: string;
  statuses?: AnnotationStatus[];
}

interface AnnotationRow {
  id: string;
  session_id: string;
  number: number;
  status: AnnotationStatus;
  data: string;
  resolved_by: ThreadRole | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  origin: string;
  pathname: string;
  url: string;
  title: string;
  project_root: string | null;
  project_root_source: ProjectRootSource | null;
  created_at: string;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  annotation_id: string;
  role: ThreadRole;
  kind: ThreadKind;
  body: string;
  created_at: string;
}

type AnnotationData = Pick<
  Annotation,
  "kind" | "comment" | "intent" | "severity" | "targets" | "selectedText" | "area" | "url" | "viewport" | "delivery"
>;

/** Rows written before API level 5 have no `delivery`. */
type StoredData = Omit<AnnotationData, "delivery"> & Partial<Pick<AnnotationData, "delivery">>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  pathname TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  project_root TEXT,
  project_root_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_session ON annotations(session_id, number);
CREATE INDEX IF NOT EXISTS annotations_status ON annotations(status);
CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_annotation ON thread(annotation_id, created_at);
`;

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("base64url")}`;

/** SQLite-backed store. Emits a ServerEvent after every committed change. */
export class Store extends EventEmitter<{ event: [ServerEvent] }> {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    super();
    // Every SSE stream and watch call holds a listener; dozens are normal.
    this.setMaxListeners(0);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.now = now;
  }

  /** Columns added after the first release; databases created before get them here. */
  private migrate(): void {
    const columns = (this.db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes("project_root_source")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN project_root_source TEXT");
      this.db.exec("UPDATE sessions SET project_root_source = 'manual' WHERE project_root IS NOT NULL");
    }
  }

  close(): void {
    this.db.close();
  }

  upsertSession(input: SessionUpsert): Session {
    const url = new URL(input.url);
    const { origin, pathname, key } = sessionKey(url, input.includeHash);
    const now = this.now();
    const existing = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(key) as SessionRow | undefined;
    if (existing) {
      this.db.prepare("UPDATE sessions SET url = ?, title = ?, updated_at = ? WHERE id = ?").run(input.url, input.title, now, existing.id);
      if (input.projectRoot) return this.setProjectRoot(existing.id, input.projectRoot, "manual");
      return this.getSession(existing.id);
    }
    const id = newId("s");
    this.db
      .prepare(
        "INSERT INTO sessions (id, session_key, origin, pathname, url, title, project_root, project_root_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, key, origin, pathname, input.url, input.title, input.projectRoot, input.projectRoot ? "manual" : null, now, now);
    return this.getSession(id);
  }

  /** Sets the project root when the source outranks the current one (see replacesRoot). */
  setProjectRoot(id: string, root: string, source: ProjectRootSource): Session {
    const current = this.getSession(id);
    if (!replacesRoot(current.projectRootSource, source)) return current;
    if (current.projectRoot === root && current.projectRootSource === source) return current;
    this.db.prepare("UPDATE sessions SET project_root = ?, project_root_source = ?, updated_at = ? WHERE id = ?").run(root, source, this.now(), id);
    return this.getSession(id);
  }

  getSession(id: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new NotFoundError(`session ${id}`);
    return toSession(row);
  }

  findSessionByUrl(rawUrl: string, includeHash = false): Session | null {
    const { key } = sessionKey(new URL(rawUrl), includeHash);
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(key) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
           COALESCE(SUM(CASE WHEN a.status IN ('pending', 'acknowledged') THEN 1 ELSE 0 END), 0) AS pending,
           COUNT(a.id) AS total
         FROM sessions s LEFT JOIN annotations a ON a.session_id = s.id
         GROUP BY s.id ORDER BY s.updated_at DESC`,
      )
      .all() as unknown as Array<SessionRow & { pending: number; total: number }>;
    return rows.map((row) => ({ ...toSession(row), pending: Number(row.pending), total: Number(row.total) }));
  }

  createAnnotation(sessionId: string, input: ParsedAnnotationInput, delivery: Delivery = deliveryOf(input)): Annotation {
    this.getSession(sessionId);
    const id = newId("a");
    const now = this.now();
    const data: AnnotationData = {
      kind: input.kind,
      comment: input.comment,
      intent: input.intent,
      severity: input.severity,
      targets: input.targets,
      selectedText: input.selectedText,
      area: input.area,
      url: input.url,
      viewport: input.viewport,
      delivery,
    };
    // Number and insert in one transaction: two daemons on one file must not hand out the same number.
    this.transaction(() => {
      const { max } = this.db
        .prepare("SELECT COALESCE(MAX(number), 0) AS max FROM annotations WHERE session_id = ?")
        .get(sessionId) as { max: number };
      this.db
        .prepare(
          "INSERT INTO annotations (id, session_id, number, status, data, resolved_by, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?)",
        )
        .run(id, sessionId, Number(max) + 1, JSON.stringify(data), now, now);
      this.touchSession(sessionId, now);
    });
    const annotation = this.getAnnotation(id);
    this.emit("event", { type: "annotation.created", annotation });
    return annotation;
  }

  getAnnotation(id: string): Annotation {
    const row = this.db.prepare("SELECT * FROM annotations WHERE id = ?").get(id) as AnnotationRow | undefined;
    if (!row) throw new NotFoundError(`annotation ${id}`);
    return this.hydrate(row);
  }

  listAnnotations(query: AnnotationQuery = {}): Annotation[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query.sessionId) {
      where.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.statuses && query.statuses.length > 0) {
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    }
    const sql = `SELECT * FROM annotations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, number`;
    const rows = this.db.prepare(sql).all(...params) as unknown as AnnotationRow[];
    return rows.map((row) => this.hydrate(row));
  }

  /** Overlay edits: content fields as is, status through the domain transitions. */
  patchAnnotation(id: string, patch: AnnotationPatch): Annotation {
    const current = this.getAnnotation(id);
    const transition = patch.status ? transitionForStatus(current.status, patch.status) : null;
    const { status: _status, ...content } = patch;
    const hasContent = Object.keys(content).length > 0;
    if (!transition && !hasContent) return current;
    this.transaction(() => {
      if (hasContent) {
        const row = this.db.prepare("SELECT data FROM annotations WHERE id = ?").get(id) as { data: string };
        const data = { ...(JSON.parse(row.data) as StoredData), ...content };
        this.db.prepare("UPDATE annotations SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), this.now(), id);
      }
      if (transition) this.applyTransitionRow(current, transition);
    });
    return this.emitUpdated(id);
  }

  transition(id: string, transition: Transition): Annotation {
    const current = this.getAnnotation(id);
    this.transaction(() => this.applyTransitionRow(current, transition));
    return this.emitUpdated(id);
  }

  /** Changes who gets the annotation: a failed background run hands it back, a new live session takes it over. */
  setDelivery(id: string, delivery: Delivery): Annotation {
    this.getAnnotation(id);
    this.transaction(() => {
      const row = this.db.prepare("SELECT data FROM annotations WHERE id = ?").get(id) as { data: string };
      const data: StoredData = { ...(JSON.parse(row.data) as StoredData), delivery };
      this.db.prepare("UPDATE annotations SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), this.now(), id);
    });
    return this.emitUpdated(id);
  }

  addMessage(id: string, role: ThreadRole, kind: ThreadKind, body: string): Annotation {
    this.getAnnotation(id);
    this.transaction(() => {
      this.insertMessage(id, role, kind, body);
      this.db.prepare("UPDATE annotations SET updated_at = ? WHERE id = ?").run(this.now(), id);
    });
    return this.emitUpdated(id);
  }

  /** Deletes and renumbers the later annotations of the session, so numbers stay 1..n everywhere. */
  deleteAnnotation(id: string): void {
    const annotation = this.getAnnotation(id);
    const shifted = this.db
      .prepare("SELECT id FROM annotations WHERE session_id = ? AND number > ? ORDER BY number")
      .all(annotation.sessionId, annotation.number) as Array<{ id: string }>;
    this.transaction(() => {
      this.db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
      this.db.prepare("UPDATE annotations SET number = number - 1 WHERE session_id = ? AND number > ?").run(annotation.sessionId, annotation.number);
    });
    this.emit("event", { type: "annotation.deleted", id, sessionId: annotation.sessionId });
    for (const row of shifted) this.emit("event", { type: "annotation.updated", annotation: this.getAnnotation(row.id) });
  }

  private applyTransitionRow(current: Annotation, transition: Transition): void {
    const result = applyTransition(current, transition);
    if (result.status === current.status && !result.message) return;
    this.db
      .prepare("UPDATE annotations SET status = ?, resolved_by = ?, updated_at = ? WHERE id = ?")
      .run(result.status, result.resolvedBy, this.now(), current.id);
    if (result.message) this.insertMessage(current.id, result.message.role, result.message.kind, result.message.body);
  }

  private insertMessage(annotationId: string, role: ThreadRole, kind: ThreadKind, body: string): void {
    this.db
      .prepare("INSERT INTO thread (id, annotation_id, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("m"), annotationId, role, kind, body, this.now());
  }

  private emitUpdated(id: string): Annotation {
    const annotation = this.getAnnotation(id);
    this.touchSession(annotation.sessionId, annotation.updatedAt);
    this.emit("event", { type: "annotation.updated", annotation });
    return annotation;
  }

  private touchSession(sessionId: string, now: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hydrate(row: AnnotationRow): Annotation {
    const { delivery = DELIVERY_OFF, ...data } = JSON.parse(row.data) as StoredData;
    const thread = (
      this.db.prepare("SELECT * FROM thread WHERE annotation_id = ? ORDER BY created_at, rowid").all(row.id) as unknown as ThreadRow[]
    ).map(
      (message): ThreadMessage => ({
        id: message.id,
        role: message.role,
        kind: message.kind,
        body: message.body,
        createdAt: message.created_at,
      }),
    );
    return {
      id: row.id,
      sessionId: row.session_id,
      number: Number(row.number),
      status: row.status,
      ...data,
      delivery,
      resolvedBy: row.resolved_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      thread,
    };
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    origin: row.origin,
    pathname: row.pathname,
    url: row.url,
    title: row.title,
    projectRoot: row.project_root,
    projectRootSource: row.project_root_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
