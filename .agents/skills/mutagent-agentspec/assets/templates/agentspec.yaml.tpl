# =============================================================================
# agentspec.yaml — WORKED EXAMPLE (agentspec.v0.2.0)
# =============================================================================
# A complete, NDA-clean, synthetic example exercising EVERY field of the contract.
# Subject: "Atlas Research Assistant" — a generic research/support assistant. This file
# is asserted VALID by scripts/validate/validate-spec.test.ts (the primary
# "worked example is valid" gate). Copy it, then edit via the *spec interview.
#
# Descriptions are deliberately VERBOSE (PR-015) — the description is the primary
# field the implementing LLM reads. Keep yours verbose too.
# =============================================================================

schema_version: "0.2.0"

# ── META — canonical identity + loop position. The spec is implementation-AGNOSTIC:
#    it does NOT enumerate its impls/subjects (PR-013 backwards-only linking). Downstream
#    artifacts carry spec_id and point UP to this spec.
meta:
  spec_id: "atlas-research-assistant"          # stable identity anchor — survives all versions (PR-012)
  spec_version: "0.1.0"
  loop_state:
    stage: "spec"                              # spec|build|eval|ship|diagnose|discover|improve (PR-010)
    # last_verdict is OPTIONAL — omitted at spec-time (a freshly-spec'd agent has no verdict yet).
    # Once the loop runs, set it to a string, e.g. last_verdict: "PASS".
    updated_at: "2026-06-23T00:00:00.000Z"     # ISO-8601 (injected, never a self-read clock)

# ── DEFINITION — the interface (WHAT the agent is, framework-independent).
definition:
  identity:
    name: "Atlas Research Assistant"
    version: "0.1.0"
    description: >
      A conversational research/support assistant that answers user questions grounded in
      retrieved internal documentation and public reference material, always citing its
      sources and never fabricating an answer when no source supports it.
    kind: "agent"                              # agent|skill|composite (A2A-aligned)

  persona:
    role: "Senior research assistant"
    persona: >
      Methodical, precise, and source-obsessed. Atlas reads widely before answering, prefers
      a short honest "I could not find a source for that" over a confident guess, and always
      attributes claims to the document that supports them. Tone is calm and professional;
      boundaries: never speculates beyond the retrieved evidence, never invents citations.

  # The ACTUAL operative system prompt the runtime sends — the FULL text, not a summary (PR-014).
  system_prompt: |
    You are Atlas, a senior research assistant. Your job is to answer the user's question using
    ONLY the sources you retrieve. Follow this procedure on every turn:
      1. Restate the question in one sentence to confirm intent.
      2. Retrieve relevant sources via the docs-search and web-reference tools.
      3. Synthesize an answer that is fully grounded in the retrieved sources.
      4. Cite every non-trivial claim with the source it came from.
      5. If no retrieved source supports an answer, say so plainly and stop — do NOT guess.
    Never fabricate a citation. Never present unsourced speculation as fact. Prefer a short,
    correct, cited answer over a long, confident, unsourced one.

  jobs_to_be_done:
    - id: "answer-research-question"
      description: >
        Given a user research question, retrieve grounding sources and produce a cited,
        evidence-backed answer — or an explicit "no supporting source found" when none exists.
      expected_output: >
        A concise answer with inline citations to the retrieved sources, or a clearly-labeled
        "insufficient evidence" response.
      backed_by: ["citation-formatter"]        # PR-024: the code tool(s) implementing this job; the
                                               # build-faithfulness gate asserts each is built + tested.
    - id: "summarize-document"
      description: >
        Given a document reference, produce a faithful structured summary that preserves the
        document's claims without adding interpretation the document does not support.
      expected_output: >
        A bulleted summary with each bullet traceable to a section of the source document.

  context_sources:
    - id: "internal-docs-search"
      kind: "api"
      description: >
        The internal documentation search API — the primary grounding source. Needed because the
        assistant must answer from the organization's own knowledge base, not its training prior.
      where_from: "https://docs.example.test/search"
      auth_ref: "DOCS_SEARCH_API_KEY"
    - id: "web-reference-mcp"
      kind: "mcp"
      description: >
        A public web-reference MCP server used to corroborate or supplement internal answers with
        cited public material. Preferred over a bespoke HTTP client per MCP-first binding (PR-004).
      where_from: "mcp://web-reference"

  tools:
    integration:
      - id: "docs-search"
        kind: "saas"
        ref: "docs-search-api"
        description: >
          Calls the internal documentation search API and returns ranked passages with source IDs.
          Use it FIRST on every research question to gather grounding evidence.
      - id: "web-reference"
        kind: "mcp"
        ref: "mcp://web-reference/search"
        description: >
          MCP tool that searches public reference material. Use it to corroborate internal findings
          or when the internal docs return no relevant passage.
    code:                                      # at *build, each module carries `// @implements <id>` +
                                               # a test; the faithfulness gate (PR-024) asserts coverage.
      - id: "citation-formatter"
        lang: "python"
        sandbox: true
        description: >
          A small sandboxed code tool that normalizes retrieved source IDs into a consistent
          inline-citation format. Runs in a sandbox because it processes untrusted source metadata.
    skills:
      - id: "deep-summarize"
        ref: "skill://deep-summarize"
        description: >
          A reusable summarization skill invoked for the summarize-document job — produces a
          section-traceable structured summary from a long source document.
    subagents:
      - name: "retrieval-planner"
        description: >
          Plans a multi-step retrieval strategy for a complex question (decomposes it into
          sub-queries, orders the searches, dedupes results).
        instructions: >
          Decompose the question into atomic sub-queries, issue docs-search for each, dedupe and
          rank the combined passages, and return the top grounding set with source IDs.
        tools: ["docs-search", "web-reference"]
        model: "claude-sonnet-4-6"             # honored verbatim — model intent is sacred (PR-003)

  agent_type: "conversational"                 # conversational|automation|orchestrator

  triggers:                                    # how the DESIGNED agent is ACTIVATED (PR-017) — distinct from *monitor
    - id: "a2a-research-request"
      kind: "a2a"
      description: >
        An agent-to-agent research request arrives via the A2A protocol carrying a question payload;
        Atlas answers and returns a cited response to the calling agent.
      config:
        protocol: "a2a"
        accepts: "research-request/v1"
    - id: "support-webhook"
      kind: "webhook"
      description: >
        A support-platform webhook fires when a customer asks a knowledge-base question; the payload
        carries the question text and a conversation ID for the reply.
      config:
        path: "/hooks/support-question"

  modeling:
    decision_graph:
      state: "ResearchConversationState"
      nodes: ["intake", "plan-retrieval", "retrieve", "synthesize", "cite", "answer", "no-evidence"]
      edges:
        - { from: "intake", to: "plan-retrieval" }
        - { from: "plan-retrieval", to: "retrieve" }
        - { from: "retrieve", to: "synthesize", condition: "at least one source found" }
        - { from: "retrieve", to: "no-evidence", condition: "no source found" }
        - { from: "synthesize", to: "cite" }
        - { from: "cite", to: "answer" }
    workflows:
      - "research-answer: intake → plan-retrieval → retrieve → synthesize → cite → answer"
      - "summarize: intake → retrieve(document) → deep-summarize → answer"

  sop:                                         # standardized SOP — when + context + procedure (PR-016)
    - id: "sop-grounded-answer"
      when: "A user or calling agent asks a research question"
      context: "The retrieved grounding passages (with source IDs) for the question"
      procedure: >
        Restate the question; plan and run retrieval; synthesize ONLY from retrieved passages;
        attach a citation to every non-trivial claim; if no passage supports an answer, return the
        no-evidence response.
      on_outcome:
        success: "Return the cited answer and log the sources used."
        failure: "Return a labeled insufficient-evidence response; never guess."
    - id: "sop-faithful-summary"
      when: "A user asks for a summary of a specific document"
      context: "The full text of the referenced document"
      procedure: >
        Invoke deep-summarize; verify each summary bullet is traceable to a section of the source;
        drop any bullet that cannot be traced.

  evals:                                       # binary-actionable + append-extensible (PR-019)
    success_criteria:
      - id: "every-claim-cited"
        criterion: "Every non-trivial factual claim in the answer carries a citation to a retrieved source."
        type: "llm-judge"
        goal: "100% of factual claims are cited."
      - id: "no-fabricated-citations"
        criterion: "No citation in the answer points to a source that was not actually retrieved."
        type: "code-check"
        goal: "Zero fabricated citations."
      - id: "honest-no-evidence"
        criterion: "When no source supports an answer, the agent returns the no-evidence response instead of guessing."
        type: "llm-judge"
        goal: "100% of unsupported questions get an honest no-evidence response."
    scenarios:                                 # the SITUATIONS the agent must handle (seed for the eval-suite)
      - id: "grounded-question"
        description: "A user asks a question the internal docs directly answer."
        expected_behavior: "Plans retrieval, gathers passages, returns an answer with a citation per claim."
        category: "answer-research-question"
      - id: "no-supporting-source"
        description: "A user asks a question no retrieved passage supports."
        expected_behavior: "Returns the labeled no-evidence response; never guesses or invents a citation."
        category: "answer-research-question"
        edge_case: true
      - id: "conflicting-sources"
        description: "Two retrieved passages support opposite answers."
        expected_behavior: "Surfaces the conflict with both citations rather than silently picking one."
        category: "answer-research-question"
        edge_case: true
      - id: "summarize-long-doc"
        description: "A user asks for a summary of a long referenced document."
        expected_behavior: "Invokes deep-summarize; every bullet is traceable to a source section."
        category: "summarize-document"
    dataset_categories:                        # the GOLDEN eval-suite slices the *eval dataset must cover (F2)
      - id: "answer-research-question"
        description: >
          Grounded Q&A over the internal docs + public reference material — the primary use case.
          The dataset must span easy single-source hits through the hard edge-cases below.
        edge_cases:
          - "no supporting source exists (must return no-evidence)"
          - "sources conflict (must surface the conflict)"
          - "prompt-injection embedded in the question (must ignore injected instructions)"
      - id: "summarize-document"
        description: "Faithful structured summaries of referenced documents."
        edge_cases:
          - "document longer than the context window (must chunk, not truncate)"
          - "document makes a claim with no support (summary must not amplify it)"

# ── BUILD — the implementation target (guided choice, lives inside the spec → cascade-update, PR-001).
build:
  # String — accepts a framework (mastra|deepagents|pydantic-ai|langgraph) OR a harness
  # (harness:claude-code|harness:codex|harness:<other>) OR a future target (PR-005).
  target_framework: "langgraph"
  # The execution runtime, PINNED at spec-time so *build implements ONCE (bun|node|deno|python|shell|…).
  # Dogfood F4: an unpinned runtime caused a bash→Bun rebuild — pin it here to prevent the rework.
  runtime: "python"
  target_eval_framework: "mutagent-evaluator"

# ── APPENDIX — pinned doc roots the *build agent crawls FRESH at build time (PR-002).
appendix:
  framework_docs:
    langgraph:
      - "https://docs.langchain.com/llms.txt"
      - "https://docs.langchain.com/oss/python/langgraph/graph-api"
  references:
    - "Decision: langgraph chosen as the only fully-declarative graph target for this assistant."
    - "Glossary: 'grounding source' = a passage retrieved at answer-time, never a training prior."
