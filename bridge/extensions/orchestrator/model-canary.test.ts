import { describe, expect, test } from "bun:test";
import { buildAliasTable, type AvailableModel } from "./models.ts";
import {
	assignCanary,
	canaryTelemetryFields,
	canaryUnit,
	wouldSelectCandidate,
	parseModelCanaries,
	type ModelCanaryConfig,
} from "./model-canary.ts";

const MODELS: AvailableModel[] = [
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
	{ provider: "openai-codex", id: "gpt-6-sol" },
	{ provider: "amazon-bedrock", id: "gpt-6-sol" },
	{ provider: "openai-codex", id: "gpt-5.6-terra" },
	{ provider: "openai-codex", id: "gpt-5.6-luna" },
	{ provider: "openai-codex", id: "gpt-6-astra" },
];
const TABLE = buildAliasTable(MODELS);
const PREF = ["openai-codex", "amazon-bedrock"];

const RAW_SAMPLE = {
	config_version: "2026-09-25.1",
	enabled: false,
	activation_available: false,
	activation_unavailable_reason: "rollout gate not yet opened",
	exclude_capabilities: ["security_review"],
	candidates: [
		{ id: "premium-gpt-5.6-sol", tier: "premium", model: "openai-codex/gpt-5.6-sol", percentage: 0 },
		{
			id: "impl-gpt-6-sol",
			capabilities: ["implementation_fast", "implementation_strong"],
			model: "openai-codex/gpt-6-sol",
			percentage: 0,
		},
	],
};

function enabledConfig(overrides: Partial<ModelCanaryConfig> = {}): ModelCanaryConfig {
	const { config } = parseModelCanaries(RAW_SAMPLE);
	return { ...config, enabled: true, activationAvailable: true, ...overrides };
}

describe("parseModelCanaries", () => {
	test("parses the documented shape with no problems", () => {
		const { config, problems } = parseModelCanaries(RAW_SAMPLE);
		expect(problems).toEqual([]);
		expect(config.enabled).toBe(false);
		expect(config.activationAvailable).toBe(false);
		expect(config.activationUnavailableReason).toBe("rollout gate not yet opened");
		expect(config.excludeCapabilities).toEqual(["security_review"]);
		expect(config.candidates).toHaveLength(2);
		expect(config.candidates[0]).toEqual({
			id: "premium-gpt-5.6-sol",
			tier: "premium",
			capabilities: undefined,
			model: "openai-codex/gpt-5.6-sol",
			percentage: 0,
		});
	});

	test("never throws on malformed input and reports problems", () => {
		expect(parseModelCanaries(null).config.enabled).toBe(false);
		expect(parseModelCanaries(null).problems.length).toBeGreaterThan(0);
		expect(parseModelCanaries(42).config.enabled).toBe(false);
		expect(parseModelCanaries("nope").problems.length).toBeGreaterThan(0);
		expect(parseModelCanaries([]).config.enabled).toBe(false);
	});

	test("ignores activation availability until qualification exists", () => {
		const { config, problems } = parseModelCanaries({ enabled: true, activation_available: true });
		expect(config.activationAvailable).toBe(false);
		expect(problems).toContain("activation_available_ignored:qualification_unavailable");
	});

	test("out-of-range percentage drops the candidate with a problem", () => {
		const { config, problems } = parseModelCanaries({
			enabled: true,
			activation_available: true,
			candidates: [{ id: "bad", tier: "premium", model: "x/y", percentage: 150 }],
		});
		expect(config.candidates).toHaveLength(0);
		expect(problems.some((p) => p.includes("percentage"))).toBe(true);
	});

	test("malformed top-level value yields a disabled config plus a problem", () => {
		const { config, problems } = parseModelCanaries({ enabled: "yes" });
		expect(config.enabled).toBe(false);
		expect(problems.some((p) => p.includes("enabled"))).toBe(true);
	});

	test("duplicate candidate ids: first kept, rest dropped with a problem", () => {
		const { config, problems } = parseModelCanaries({
			candidates: [
				{ id: "dup", tier: "mid", model: "a/b", percentage: 0 },
				{ id: "dup", tier: "mid", model: "c/d", percentage: 0 },
			],
		});
		expect(config.candidates).toHaveLength(1);
		expect(problems.some((p) => p.includes("duplicate id"))).toBe(true);
	});
});

describe("canaryUnit", () => {
	test("matches Python orchestrator/adaptive.py::_unit_interval bit-for-bit", () => {
		// Computed via:
		//   python3 -c "import hashlib; h=hashlib.sha256(b'<seed>').hexdigest()[:16]; \
		//     print(int(h,16)/float(0xFFFFFFFFFFFFFFFF))"
		expect(canaryUnit("canary:run-123:premium-gpt-5.6-sol")).toBe(0.629810507421559);
		expect(canaryUnit("canary:run-abc:impl-gpt-6-sol")).toBe(0.704654245863177);
	});

	test("deterministic across repeated calls", () => {
		const seed = "canary:run-xyz:some-candidate";
		expect(canaryUnit(seed)).toBe(canaryUnit(seed));
	});
});

describe("assignCanary: config-level gating", () => {
	test("0% default across 1000 run ids never yields candidate", () => {
		const { config } = parseModelCanaries(RAW_SAMPLE);
		for (let i = 0; i < 1000; i++) {
			const a = assignCanary({
				runId: `run-${i}`,
				capability: "implementation_fast",
				baselineModel: "openai-codex/gpt-5.6-luna",
				explicitOverride: false,
				config,
				aliasTable: TABLE,
				preference: PREF,
			});
			expect(a.cohort).not.toBe("candidate");
			expect(a.requestedModel).toBe("openai-codex/gpt-5.6-luna");
		}
	});

	test("determinism: same run id + candidate always assigns the same cohort", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 50 }],
		});
		const input = {
			runId: "run-stable",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		};
		const first = assignCanary(input);
		for (let i = 0; i < 5; i++) {
			// Simulates a retry/attempt re-evaluating the same run+capability.
			expect(assignCanary(input)).toEqual(first);
		}
	});

	test("!enabled reports activation disabled and stays on baseline", () => {
		const config = enabledConfig({
			enabled: false,
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.activation).toBe("disabled");
		expect(a.cohort).toBe("baseline");
		expect(a.requestedModel).toBe("openai-codex/gpt-5.6-luna");
	});

	test("!activation_available surfaces the configured reason", () => {
		const config = enabledConfig({
			activationAvailable: false,
			activationUnavailableReason: "rollout gate not yet opened",
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.activation).toBe("unavailable");
		expect(a.cohort).toBe("baseline");
		expect(a.reason).toBe("rollout gate not yet opened");
	});

	test("explicit user override is preserved even when the candidate is otherwise fully active", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: true,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.cohort).toBe("ineligible");
		expect(a.reason).toBe("explicit_user_override");
		expect(a.requestedModel).toBe("openai-codex/gpt-5.6-luna");
	});

	test("security_review is excluded even though the premium candidate's tier would otherwise match", () => {
		const config = enabledConfig({
			candidates: [{ id: "premium-gpt-5.6-sol", tier: "premium", model: "openai-codex/gpt-5.6-sol", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "security_review",
			baselineModel: "openai-codex/gpt-5.6-terra",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.cohort).toBe("baseline");
		expect(a.reason).toBe("capability_excluded");
		expect(a.candidateId).toBeUndefined();
	});
});

describe("assignCanary: eligibility", () => {
	test("premium-tier candidate is eligible for a premium capability but not for implementation capabilities", () => {
		const config = enabledConfig({
			candidates: [{ id: "premium-gpt-5.6-sol", tier: "premium", model: "openai-codex/gpt-5.6-sol", percentage: 100 }],
		});
		const architect = assignCanary({
			runId: "run-arch",
			capability: "architect",
			baselineModel: "openai-codex/gpt-5.6-terra",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(architect.candidateId).toBe("premium-gpt-5.6-sol");
		const impl = assignCanary({
			runId: "run-impl",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(impl.candidateId).toBeUndefined();
		expect(impl.reason).toBe("no_matching_candidate");
	});

	test("capability-listed candidate is eligible for implementation capabilities but not for an unrelated premium capability", () => {
		const config = enabledConfig({
			candidates: [
				{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast", "implementation_strong"], model: "openai-codex/gpt-6-sol", percentage: 100 },
			],
		});
		const strong = assignCanary({
			runId: "run-strong",
			capability: "implementation_strong",
			baselineModel: "openai-codex/gpt-5.6-terra",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(strong.candidateId).toBe("impl-gpt-6-sol");
		const architect = assignCanary({
			runId: "run-arch2",
			capability: "architect",
			baselineModel: "openai-codex/gpt-5.6-terra",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(architect.candidateId).toBeUndefined();
	});

	test("candidate resolving to a lower tier than the baseline is rejected", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_strong"], model: "openai-codex/gpt-5.6-luna", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_strong",
			baselineModel: "openai-codex/gpt-6-astra", // classifies as frontier
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.cohort).toBe("ineligible");
		expect(a.reason).toBe("tier_lowering_rejected");
		expect(a.requestedModel).toBe("openai-codex/gpt-6-astra");
	});

	test("unresolvable candidate model is ineligible, never assumed available", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/no-such-model", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.cohort).toBe("ineligible");
		expect(a.reason).toMatch(/^candidate_unresolvable:/);
	});

	test("candidate that resolves to the same model as the baseline is ineligible", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-5.6-luna", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(a.cohort).toBe("ineligible");
		expect(a.reason).toBe("candidate_equals_baseline");
	});

	test("missing alias table treats the candidate as unresolvable rather than assuming availability", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }],
		});
		const a = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: null,
		});
		expect(a.cohort).toBe("ineligible");
		expect(a.reason).toMatch(/^candidate_unresolvable:/);
	});
});

describe("assignCanary: qualification gate", () => {
	test("hostile enabled config cannot activate a candidate", () => {
		const config = enabledConfig({ candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }] });
		const a = assignCanary({ runId: "hostile", capability: "implementation_fast", baselineModel: "openai-codex/gpt-5.6-luna", explicitOverride: false, config, aliasTable: TABLE, preference: PREF });
		expect(a.requestedModel).toBe(a.baselineModel);
		expect(a.activation).toBe("unavailable");
		expect(a.cohort).toBe("baseline");
	});
});

describe("assignCanary: full activation", () => {
	test("percentage=100 always lands in candidate cohort when otherwise eligible", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }],
		});
		for (const runId of ["run-a", "run-b", "run-c"]) {
			expect(wouldSelectCandidate(runId, "impl-gpt-6-sol", 100)).toBe(true);
			const a = assignCanary({
				runId,
				capability: "implementation_fast",
				baselineModel: "openai-codex/gpt-5.6-luna",
				explicitOverride: false,
				config,
				aliasTable: TABLE,
				preference: PREF,
			});
			expect(a.cohort).toBe("baseline");
			expect(a.activation).toBe("unavailable");
			expect(a.requestedModel).toBe("openai-codex/gpt-5.6-luna");
		}
	});

	test("partial percentage is decided by canaryUnit against runId+candidateId, not the raw runId", () => {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 65 }],
		});
		const seed = "canary:run-123:impl-gpt-6-sol";
		const unit = canaryUnit(seed);
		const a = assignCanary({
			runId: "run-123",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		expect(wouldSelectCandidate("run-123", "impl-gpt-6-sol", 65)).toBe(unit < 0.65);
		expect(a.cohort).toBe("baseline");
		expect(a.activation).toBe("unavailable");
	});
});

describe("canaryTelemetryFields", () => {
	function activeAssignment() {
		const config = enabledConfig({
			candidates: [{ id: "impl-gpt-6-sol", capabilities: ["implementation_fast"], model: "openai-codex/gpt-6-sol", percentage: 100 }],
		});
		const assignment = assignCanary({
			runId: "run-1",
			capability: "implementation_fast",
			baselineModel: "openai-codex/gpt-5.6-luna",
			explicitOverride: false,
			config,
			aliasTable: TABLE,
			preference: PREF,
		});
		// Telemetry formatting can be tested with a synthetic active result; the
		// assignment function itself must remain gated until qualification ships.
		return { ...assignment, cohort: "candidate" as const, activation: "active" as const, requestedModel: "openai-codex/gpt-6-sol", reason: "canary_active" };
	}

	test("flat snake_case fields, no deviation when executed matches requested", () => {
		const a = activeAssignment();
		const fields = canaryTelemetryFields(a, a.requestedModel, "attempt-1");
		expect(fields).toEqual({
			canary_cohort: "candidate",
			canary_candidate_id: "impl-gpt-6-sol",
			canary_activation: "active",
			canary_reason: "canary_active",
			canary_policy_version: "2026-09-25.1",
			baseline_model: "openai-codex/gpt-5.6-luna",
			candidate_model: "openai-codex/gpt-6-sol",
			requested_model: "openai-codex/gpt-6-sol",
			executed_model: "openai-codex/gpt-6-sol",
			canary_attempt_id: "attempt-1",
			canary_deviation: null,
		});
	});

	test("provider substitution: same model id, different provider", () => {
		const a = activeAssignment();
		const fields = canaryTelemetryFields(a, "amazon-bedrock/gpt-6-sol", "attempt-2");
		expect(fields.canary_deviation).toBe("provider_substitution");
	});

	test("Bedrock regional model ids preserve provider substitution attribution", () => {
		const a = { ...activeAssignment(), requestedModel: "openai-codex/gpt-6-astra" };
		for (const executed of ["amazon-bedrock/global.openai.gpt-6-astra", "amazon-bedrock/us.openai.gpt-6-astra"]) {
			const fields = canaryTelemetryFields(a, executed, "attempt-bedrock");
			expect(fields.canary_deviation).toBe("provider_substitution");
		}
	});

	test("model substitution: different model id entirely", () => {
		const a = activeAssignment();
		const fields = canaryTelemetryFields(a, "openai-codex/gpt-5.6-luna", "attempt-3");
		expect(fields.canary_deviation).toBe("model_substitution");
	});

	test("unknown deviation and null executed_model when the executed model is not yet known", () => {
		const a = activeAssignment();
		const fields = canaryTelemetryFields(a, undefined, "attempt-4");
		expect(fields.executed_model).toBeNull();
		expect(fields.canary_deviation).toBe("unknown");
	});
});
