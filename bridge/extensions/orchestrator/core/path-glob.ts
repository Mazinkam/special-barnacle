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
			re += slash ? "(?:.*/)?" : ".*";
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

export function matchesAny(path: string, globs: string[]): string[] {
	return globs.filter((g) => globToRegExp(g).test(path));
}
