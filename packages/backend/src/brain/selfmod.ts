import { execFile, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { Store } from "../memory/store.js";

/**
 * 自己改修（self-modification）の実装.
 * 谺が自分自身のソースコードを読み, 変更をステージし, 隔離コピー上で型検査してから
 * 実ファイルへ適用・再起動する. 会話は再起動をまたいで継続される（orchestrator が
 * selfmodResume 設定で直前セッションの履歴を引き継ぐ）.
 *
 * 安全設計:
 * - 変更はまずメモリ上にステージされ, 実ファイルには触れない.
 * - 検証は data/selfmod/stage への隔離コピー＋tsc で行う（実ツリー無傷のまま）.
 * - 適用時は元ファイルを data/selfmod/backups/ へ退避し, pending.json を残す.
 * - 起動に失敗した場合, 監督プロセス（scripts/serve-forever.mjs）が pending.json を
 *   見てバックアップから巻き戻し, rolledback.json で谺に失敗を知らせる.
 * - 書き込み先は packages/(backend|frontend|shared)/src と scripts/ に限定し,
 *   .env・data・node_modules 等には触れない.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** リポジトリ直下（tsx実行時: src/brain から4階層上） */
export const REPO_ROOT = resolve(here, "..", "..", "..", "..");

/** 自己改修が可能な環境か（ソースツリー＋node_modules が手元にあるか）. パッケージ版は不可. */
export function selfModAvailable(): boolean {
  return (
    existsSync(join(REPO_ROOT, "packages", "backend", "src", "index.ts")) &&
    existsSync(join(REPO_ROOT, "node_modules")) &&
    existsSync(join(REPO_ROOT, "tsconfig.base.json"))
  );
}

/** 書き込みを許可するリポジトリ相対パスの接頭辞 */
const WRITABLE_PREFIXES = [
  "packages/backend/src/",
  "packages/frontend/src/",
  "packages/shared/src/",
  "scripts/",
];
/** 書き込みを許可する拡張子 */
const WRITABLE_EXTS = [".ts", ".tsx", ".css", ".mjs", ".cjs", ".json", ".html", ".md"];
/** 参照・列挙から常に除外するディレクトリ/ファイル名 */
const DENIED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "data",
  "models",
  "dist",
  "public",
  ".DS_Store",
]);

export class SelfMod {
  /** ステージ中の変更（リポジトリ相対パス → 変更後の全文） */
  private staged = new Map<string, string>();
  /** 現在のステージ内容が型検査を通過済みか */
  private validated = false;

  private get selfmodDir(): string {
    return join(config.dataDir, "selfmod");
  }

  hasStaged(): boolean {
    return this.staged.size > 0;
  }

  isValidated(): boolean {
    return this.validated;
  }

  /** パスを正規化し, リポジトリ内に収まっていることを保証して相対パスを返す. */
  private normalize(relIn: string): string {
    const rel = relative(REPO_ROOT, resolve(REPO_ROOT, relIn.trim()));
    if (!rel || rel.startsWith("..")) {
      throw new Error(`リポジトリ外のパスです: ${relIn}`);
    }
    for (const seg of rel.split("/")) {
      if (DENIED_SEGMENTS.has(seg) || seg.startsWith(".env")) {
        throw new Error(`このパスへはアクセスできません: ${rel}`);
      }
    }
    return rel;
  }

  /** 書き込み可能なパスであることを検証する. */
  private assertWritable(relIn: string): string {
    const rel = this.normalize(relIn);
    if (!WRITABLE_PREFIXES.some((p) => rel.startsWith(p))) {
      throw new Error(
        `書き込みは ${WRITABLE_PREFIXES.join(", ")} 配下に限定されています: ${rel}`,
      );
    }
    if (!WRITABLE_EXTS.some((e) => rel.endsWith(e))) {
      throw new Error(`この拡張子は変更できません: ${rel}`);
    }
    return rel;
  }

  // --- 参照 -------------------------------------------------------------

  /** ソースツリーの一覧（既定: 各パッケージの src と scripts）. */
  listSource(dirIn?: string): string {
    const roots = dirIn
      ? [this.normalize(dirIn)]
      : [
          "packages/shared/src",
          "packages/backend/src",
          "packages/frontend/src",
          "scripts",
        ];
    const lines: string[] = [];
    const walk = (rel: string) => {
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) return;
      const st = statSync(abs);
      if (!st.isDirectory()) {
        lines.push(`${rel}（${st.size}バイト）`);
        return;
      }
      for (const name of readdirSync(abs).sort()) {
        if (DENIED_SEGMENTS.has(name) || name.startsWith(".env")) continue;
        if (lines.length >= 400) return;
        walk(join(rel, name));
      }
    };
    for (const r of roots) walk(r);
    if (!lines.length) return "該当するファイルはありません．";
    const stagedNote = this.staged.size
      ? `\n\n【ステージ中の変更（未適用）】\n${[...this.staged.keys()].map((p) => `- ${p}`).join("\n")}`
      : "";
    return lines.join("\n") + stagedNote;
  }

  /** ソースファイルの内容を返す（ステージ中の変更があればそちらを返す）. */
  readSource(relIn: string): string {
    const rel = this.normalize(relIn);
    if (this.staged.has(rel)) {
      return `【注意: 以下はステージ中（未適用）の内容です】\n${this.staged.get(rel)}`;
    }
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) return `ファイルが存在しません: ${rel}`;
    const st = statSync(abs);
    if (st.isDirectory()) return this.listSource(rel);
    if (st.size > 256 * 1024) return `ファイルが大きすぎます（${st.size}バイト）: ${rel}`;
    return readFileSync(abs, "utf8");
  }

  // --- ステージ ----------------------------------------------------------

  /** 部分置換で変更をステージする（old は一意に一致しなければならない）. */
  stageEdit(relIn: string, oldStr: string, newStr: string): string {
    const rel = this.assertWritable(relIn);
    const abs = join(REPO_ROOT, rel);
    const cur = this.staged.get(rel) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : null);
    if (cur === null) {
      return `ファイルが存在しません: ${rel}（新規作成は content を渡してください）`;
    }
    const parts = cur.split(oldStr);
    if (parts.length === 1) {
      return `old_string が「${rel}」内に見つかりません．self_read_source で現在の内容を確認してください．`;
    }
    if (parts.length > 2) {
      return `old_string が${parts.length - 1}箇所に一致します．一意になるよう前後の文脈を含めてください．`;
    }
    this.staged.set(rel, parts.join(newStr));
    this.validated = false;
    return `「${rel}」への変更をステージしました（まだ未適用）．ステージ中: ${this.staged.size}件．全変更が揃ったら self_validate_changes で検証してください．`;
  }

  /** ファイル全文（新規作成含む）で変更をステージする. */
  stageWrite(relIn: string, content: string): string {
    const rel = this.assertWritable(relIn);
    this.staged.set(rel, content);
    this.validated = false;
    return `「${rel}」の全文をステージしました（まだ未適用）．ステージ中: ${this.staged.size}件．全変更が揃ったら self_validate_changes で検証してください．`;
  }

  /** ステージ中の変更をすべて破棄する. */
  discard(): string {
    const n = this.staged.size;
    this.staged.clear();
    this.validated = false;
    return n ? `${n}件のステージ変更を破棄しました．` : "破棄する変更はありません．";
  }

  // --- 検証（隔離コピー＋tsc） -------------------------------------------

  /**
   * ステージ中の変更を隔離コピーへ重ねて型検査する. 実ツリーには一切触れない.
   * shared/backend は常に, frontend は変更が及ぶ場合のみ検査する.
   */
  async validate(): Promise<string> {
    if (!this.staged.size) return "ステージされた変更がありません．";
    const stage = this.buildStage();
    const touched = [...this.staged.keys()];
    const sharedTouched = touched.some((p) => p.startsWith("packages/shared/"));
    const feTouched = touched.some((p) => p.startsWith("packages/frontend/"));
    const pkgs = ["shared", "backend", ...(feTouched || sharedTouched ? ["frontend"] : [])];

    for (const pkg of pkgs) {
      const err = await this.tscCheck(stage, pkg);
      if (err) {
        this.validated = false;
        return `型検査に失敗しました（packages/${pkg}）:\n${err}\n\n修正して再度ステージ・検証してください．`;
      }
    }
    this.validated = true;
    return (
      `型検査に通りました（対象: ${pkgs.join(", ")}／変更 ${touched.length}件: ${touched.join(", ")}）．` +
      "主人の承認が済んでいれば self_restart で適用・再起動できます．"
    );
  }

  /** 実ツリーの写し＋ステージ変更を data/selfmod/stage に組み立てる. */
  private buildStage(): string {
    const stage = join(this.selfmodDir, "stage");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    cpSync(join(REPO_ROOT, "tsconfig.base.json"), join(stage, "tsconfig.base.json"));
    for (const pkg of ["shared", "backend", "frontend"]) {
      const src = join(REPO_ROOT, "packages", pkg);
      const dst = join(stage, "packages", pkg);
      mkdirSync(dst, { recursive: true });
      for (const f of ["package.json", "tsconfig.json", "vite.config.ts"]) {
        if (existsSync(join(src, f))) cpSync(join(src, f), join(dst, f));
      }
      cpSync(join(src, "src"), join(dst, "src"), { recursive: true });
    }
    // 依存は実リポジトリの node_modules をそのまま参照する.
    symlinkSync(join(REPO_ROOT, "node_modules"), join(stage, "node_modules"), "dir");
    for (const [rel, content] of this.staged) {
      const p = join(stage, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
    return stage;
  }

  /** 隔離コピー上で1パッケージを tsc --noEmit する. 成功なら null, 失敗ならエラー文. */
  private tscCheck(stage: string, pkg: string): Promise<string | null> {
    // @kodama/shared は node_modules 経由だと実ツリーの shared を見てしまうため,
    // paths でステージ内の shared/src へ張り替えて検査する.
    const cfgPath = join(stage, "packages", pkg, "tsconfig.selfcheck.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          // baseUrl は TS6 で非推奨. paths は tsconfig の場所を基準に解決される.
          paths: { "@kodama/shared": ["../shared/src/index.ts"] },
        },
      }),
    );
    const tsc = join(REPO_ROOT, "node_modules", ".bin", "tsc");
    return new Promise((resolvePromise) => {
      execFile(
        tsc,
        ["-p", cfgPath],
        // cwd をステージ直下にし, エラー出力のパスを読みやすい相対表記にする.
        { cwd: stage, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolvePromise(null);
          const out = `${stdout ?? ""}\n${stderr ?? ""}`
            .replaceAll(`${stage}/`, "")
            .trim();
          resolvePromise(out.slice(0, 4000) || `tsc の実行に失敗: ${error.message}`);
        },
      );
    });
  }

  // --- 適用・再起動 --------------------------------------------------------

  /**
   * ステージ済みの変更を実ツリーへ適用し, プロセスを再起動する.
   * 呼び出し前に読み上げが完了していること（orchestrator が保証する）.
   * 監督プロセス（KODAMA_SUPERVISED=1）下では exit(87) で即再起動を要求し,
   * tsx watch 下ではファイル変更自体が再起動を誘発する（保険として遅延exitも張る）.
   */
  commitAndRestart(note: string, prevSessionId: string, store: Store): void {
    // 1) 何より先に再開マーカーを永続化する（ファイル書き込みが即時再起動を
    //    誘発しても, 再起動後に会話を引き継げるように）.
    store.setSetting("selfmodResume", {
      prevSessionId,
      note,
      at: new Date().toISOString(),
    });

    const files = [...this.staged.keys()];
    if (files.length) {
      // 2) 元ファイルをバックアップし, 巻き戻し情報（pending.json）を残す.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupDir = join(this.selfmodDir, "backups", ts);
      for (const rel of files) {
        const abs = join(REPO_ROOT, rel);
        if (existsSync(abs)) {
          const dst = join(backupDir, rel);
          mkdirSync(dirname(dst), { recursive: true });
          cpSync(abs, dst);
        }
      }
      mkdirSync(this.selfmodDir, { recursive: true });
      writeFileSync(
        join(this.selfmodDir, "pending.json"),
        JSON.stringify({ at: new Date().toISOString(), note, backupDir, files }, null, 2),
      );

      // 3) 実ツリーへ書き込む.
      for (const [rel, content] of this.staged) {
        const abs = join(REPO_ROOT, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }

      // 4) フロントエンドに変更が及ぶ場合は dist を再ビルドする（監督下のみ.
      //    dev 環境では vite build --watch が自動で再生成する）.
      const feTouched = files.some((p) => p.startsWith("packages/frontend/"));
      if (feTouched && process.env.KODAMA_SUPERVISED) {
        const r = spawnSync("npm", ["run", "build:web"], {
          cwd: REPO_ROOT,
          timeout: 180_000,
          encoding: "utf8",
        });
        if (r.status !== 0) {
          console.log("[selfmod] フロントエンドのビルドに失敗（型検査は通過済みのため続行）");
        }
      }
      this.staged.clear();
      this.validated = false;
      console.log(`[selfmod] ${files.length}件の変更を適用しました: ${files.join(", ")}`);
    }

    // 5) 再起動. 監督下は即時, tsx watch 下はファイル変更による自動再起動を待つ
    //    （来なかった場合の保険として遅延 exit(87)）.
    const delay = process.env.KODAMA_SUPERVISED ? 400 : 8000;
    console.log(`[selfmod] ${delay}ms 後に再起動します（exit 87）`);
    setTimeout(() => {
      try {
        store.close();
      } catch {
        /* 無視 */
      }
      process.exit(87);
    }, delay);
  }

  // --- 起動時の後始末（orchestrator.start から呼ばれる） -------------------

  /** 起動成功の宣言: pending.json を消し, 監督プロセスの巻き戻し対象から外す. */
  markBootOk(): void {
    rmSync(join(this.selfmodDir, "pending.json"), { force: true });
  }

  /** 監督プロセスが巻き戻しを行っていたら, その記録を読み取って消す. */
  consumeRollback(): { note: string; reason: string } | null {
    const p = join(this.selfmodDir, "rolledback.json");
    if (!existsSync(p)) return null;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as {
        note?: string;
        reason?: string;
      };
      rmSync(p, { force: true });
      return { note: j.note ?? "", reason: j.reason ?? "起動失敗" };
    } catch {
      rmSync(p, { force: true });
      return { note: "", reason: "起動失敗" };
    }
  }
}
