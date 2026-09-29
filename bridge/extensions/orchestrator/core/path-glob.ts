/** Minimal, dependency-free glob → RegExp for repo-relative POSIX paths. */
export function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${translateGlob(glob)}$`);
}

function translateGlob(glob: string): string {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			re += slash ? "(?:[\\s\\S]*/)?" : "[\\s\\S]*";
			i += slash ? 2 : 1;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end < 0) { re += "\\{"; continue; }
			re += `(?:${glob.slice(i + 1, end).split(",").map(translateGlob).join("|")})`;
			i = end;
		} else re += escape(c);
	}
	return re;
}

function escape(s: string): string {
	return s.replace(/[.*?+^${}()|[\]\\]/g, "\\$&");
}

/** Max brace-expansion alternatives per glob; exceeding it throws (never a silent non-match). */
const MAX_EXPANSIONS = 256;

type Token = { k: "lit"; c: string } | { k: "?" | "*" | "**" | "**/" };

/** Expand a glob into token sequences (one per brace alternative). Mirrors translateGlob. */
function expand(glob: string): Token[][] {
	let seqs: Token[][] = [[]];
	const push = (t: Token) => { for (const q of seqs) q.push(t); };
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			if (glob[i + 2] === "/") { push({ k: "**/" }); i += 2; } else { push({ k: "**" }); i += 1; }
		} else if (c === "*") push({ k: "*" });
		else if (c === "?") push({ k: "?" });
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end < 0) { push({ k: "lit", c }); continue; }
			const alts = glob.slice(i + 1, end).split(",").flatMap(expand);
			if (seqs.length * alts.length > MAX_EXPANSIONS) {
				throw new Error(`path-glob: brace expansion exceeds ${MAX_EXPANSIONS} alternatives: ${glob}`);
			}
			seqs = seqs.flatMap((q) => alts.map((a) => [...q, ...a]));
			i = end;
		} else push({ k: "lit", c });
	}
	if (seqs.length > MAX_EXPANSIONS) throw new Error(`path-glob: brace expansion exceeds ${MAX_EXPANSIONS} alternatives: ${glob}`);
	return seqs;
}

/** Non-backtracking O(tokens × path length) match using two rolling DP rows. */
function matchTokens(tokens: Token[], path: string): boolean {
	const n = path.length;
	let next = new Array<boolean>(n + 1).fill(false); // row for ti+1
	next[n] = true;
	for (let ti = tokens.length - 1; ti >= 0; ti--) {
		const t = tokens[ti];
		const cur = new Array<boolean>(n + 1).fill(false);
		if (t.k === "lit") {
			for (let p = 0; p < n; p++) cur[p] = path[p] === t.c && next[p + 1];
		} else if (t.k === "?") {
			for (let p = 0; p < n; p++) cur[p] = path[p] !== "/" && next[p + 1];
		} else if (t.k === "*") {
			cur[n] = next[n];
			for (let p = n - 1; p >= 0; p--) cur[p] = next[p] || (path[p] !== "/" && cur[p + 1]);
		} else if (t.k === "**") {
			cur[n] = next[n];
			for (let p = n - 1; p >= 0; p--) cur[p] = next[p] || cur[p + 1];
		} else {
			// "**/" = optional (anything followed by "/")
			let inStar = false; // inStar[p+1]
			cur[n] = next[n];
			for (let p = n - 1; p >= 0; p--) {
				inStar = (path[p] === "/" && next[p + 1]) || inStar;
				cur[p] = next[p] || inStar;
			}
		}
		next = cur;
	}
	return next[0];
}

export function matchesAny(path: string, globs: string[]): string[] {
	return globs.filter((g) => expand(g).some((tokens) => matchTokens(tokens, path)));
}
