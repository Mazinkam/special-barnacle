export interface DiscoveredCheck { name: string; argv: string[]; cwd: string; source: string }
export interface RepoReader { exists(rel: string): boolean; read(rel: string): string | null }

const SCRIPT_ORDER = ["typecheck", "lint", "test"] as const;

function join(dir: string, file: string): string {
	return dir === "." || dir === "" ? file : `${dir}/${file}`;
}

function runner(reader: RepoReader, dir: string): string[] {
	const at = (f: string) => reader.exists(join(dir, f)) || reader.exists(f);
	if (at("bun.lock") || at("bun.lockb")) return ["bun", "run"];
	if (at("pnpm-lock.yaml")) return ["pnpm", "run"];
	if (at("yarn.lock")) return ["yarn"];
	return ["npm", "run"];
}

function label(dir: string, name: string): string {
	return dir === "." || dir === "" ? name : `${dir}:${name}`;
}

export function discoverChecks(reader: RepoReader, packageDirs: string[] = ["."]): DiscoveredCheck[] {
	const out: DiscoveredCheck[] = [];
	for (const dir of packageDirs) {
		const pkgPath = join(dir, "package.json");
		const pkgText = reader.read(pkgPath);
		if (pkgText !== null) {
			try {
				const scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {};
				for (const s of SCRIPT_ORDER) {
					if (typeof scripts[s] === "string") out.push({ name: label(dir, s), argv: [...runner(reader, dir), s], cwd: dir, source: pkgPath });
				}
			} catch {
				// malformed package.json: no checks from it
			}
		}
		const py = ["pyproject.toml", "pytest.ini", "setup.cfg"].find((f) => reader.exists(join(dir, f)));
		if (py && reader.exists(join(dir, "tests"))) out.push({ name: label(dir, "pytest"), argv: ["python3", "-m", "pytest", "-q"], cwd: dir, source: join(dir, py) });
		const make = reader.read(join(dir, "Makefile"));
		if (make !== null && /^test\s*:/m.test(make)) out.push({ name: label(dir, "make test"), argv: ["make", "test"], cwd: dir, source: join(dir, "Makefile") });
	}
	const seen = new Set<string>();
	return out.filter((c) => { const k = `${c.cwd}\0${c.argv.join("\0")}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
