export function normalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

export function hostRuleValid(rule: string): boolean {
  if (rule === "*") return true;
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return suffix.includes(".") && /^[a-z0-9.-]+$/.test(suffix) && !suffix.startsWith(".") && !suffix.endsWith(".");
  }
  if (rule.includes("*") || rule.includes("/") || rule.includes(" ")) return false;
  return rule.length > 0 && rule.length <= 253;
}

/**
 * Match a URL hostname against allowHosts.
 * `example.com` is exact. `*.example.com` is one or more labels underneath, not the apex.
 * `*` permits every host and must be set on purpose.
 */
export function hostAllowed(hostname: string, allowHosts: string[]): { ok: boolean; reason: string } {
  const host = normalHost(hostname);
  if (allowHosts.length === 0) {
    return {
      ok: false,
      reason: `Host ${host} was refused because allowHosts is empty. Add the merchant hostname to the config. Nothing was reserved.`,
    };
  }
  for (const raw of allowHosts) {
    const rule = raw.toLowerCase().replace(/\.$/, "");
    if (rule === "*") {
      return { ok: true, reason: "allowHosts is *, which permits every hostname." };
    }
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) {
        return { ok: true, reason: `Host ${host} matches ${raw}.` };
      }
      continue;
    }
    if (host === normalHost(rule)) {
      return { ok: true, reason: `Host ${host} is on the allowlist.` };
    }
  }
  return {
    ok: false,
    reason: `Host ${host} is not on the allowlist (${allowHosts.join(", ")}). Nothing was reserved.`,
  };
}
