/**
 * scripts/ui-slots.ts — EV-039/040 HTML-artifact missing-data audit (Code-only).
 * ---------------------------------------------------------------------------
 * The operator's first-class case: *"if a skill/agent produces an HTML artifact,
 * data-leak is concerned with MISSING DATA in the UI representation."* A value
 * the agent COMPUTED but did NOT render is a missing-data leak.
 *
 * This is the deterministic, SUBJECT-AGNOSTIC half of the EV-039/040 Hybrid: it
 * cross-references a PROFILE-SUPPLIED expected-UI-slot list (EV-037
 * `expectedUiSlots`, NOT the v1 diagnostics-specific hardcoded slot names) against
 * the agent's computed values + the published HTML, and classifies each slot:
 *   - computed-but-not-rendered (EV-039) — a value computed yet ABSENT from the
 *     HTML → missing-data leak (locus UI, cls B). The operator's exact case;
 *     works on the HTML-only path (the v1 OUTSIDER FALLBACK promoted to
 *     first-class — no intermediate render-input file required).
 *   - orphan slot (EV-039) — the HTML references the slot but NO producer
 *     computed it → drawn-but-empty.
 *   - faithful — computed AND rendered verbatim → explicitly NOT a leak.
 * Nuanced faithfulness (altered/truncated, EV-040) is left to the judge — this
 * helper flags only verbatim presence/absence (it decides no severity).
 *
 * PURE + deterministic: no clock / random / network; same inputs → same audit.
 */

/** Classification of one expected UI slot. */
export const UiSlotKind = {
  /** Computed by the agent but ABSENT from the rendered HTML (EV-039 leak). */
  ComputedNotRendered: "computed-not-rendered",
  /** Referenced in the HTML but NO producer computed it (EV-039 orphan). */
  OrphanSlot: "orphan-slot",
  /** Computed AND rendered verbatim — NOT a leak. */
  Faithful: "faithful",
  /** Neither computed nor referenced in the HTML — out of scope this run. */
  Absent: "absent",
} as const;
export type UiSlotKindValue = (typeof UiSlotKind)[keyof typeof UiSlotKind];

export interface UiSlotFinding {
  slot: string;
  kind: UiSlotKindValue;
  /** the computed value string (when the agent produced one). */
  computedValue?: string;
  /** whether the slot is referenced (by name) anywhere in the HTML. */
  slotReferenced: boolean;
  /** whether the computed value appears verbatim in the HTML. */
  valueRendered: boolean;
}

export interface UiSlotAuditInput {
  /** EV-037 profile-supplied expected UI slots (subject-agnostic). */
  expectedSlots: string[];
  /** slot -> the value the agent COMPUTED (from trace / runMeta / intermediate). */
  computedSlots: Record<string, string>;
  /** the published HTML artifact text (the HTML-only path is supported). */
  renderedHtml: string;
}

export interface UiSlotAudit {
  findings: UiSlotFinding[];
  /** EV-039 leaks: computed but not in the HTML. */
  computedNotRendered: string[];
  /** EV-039 orphans: referenced in the HTML but never computed. */
  orphanSlots: string[];
}

/** Does the HTML reference this slot by name (a token match)? */
function slotReferenced(html: string, slot: string): boolean {
  if (slot.length === 0) return false;
  return html.includes(slot);
}

/** Does the computed value appear verbatim in the HTML? */
function valueRendered(html: string, value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  return html.includes(v);
}

/**
 * Audit the expected UI slots against the computed values + the rendered HTML.
 * PURE + deterministic. SUBJECT-AGNOSTIC — the slot list is supplied, never a
 * module constant. Findings are emitted in `expectedSlots` order (stable).
 */
export function auditUiSlots(input: UiSlotAuditInput): UiSlotAudit {
  const findings: UiSlotFinding[] = [];
  const computedNotRendered: string[] = [];
  const orphanSlots: string[] = [];

  for (const slot of input.expectedSlots) {
    const hasComputed = Object.prototype.hasOwnProperty.call(input.computedSlots, slot);
    const computedValue = hasComputed ? input.computedSlots[slot] : undefined;
    const referenced = slotReferenced(input.renderedHtml, slot);
    const rendered =
      computedValue !== undefined && valueRendered(input.renderedHtml, computedValue);

    let kind: UiSlotKindValue;
    if (hasComputed && !rendered) {
      kind = UiSlotKind.ComputedNotRendered; // EV-039: computed but missing from HTML
      computedNotRendered.push(slot);
    } else if (!hasComputed && referenced) {
      kind = UiSlotKind.OrphanSlot; // EV-039: drawn but no producer
      orphanSlots.push(slot);
    } else if (hasComputed && rendered) {
      kind = UiSlotKind.Faithful;
    } else {
      kind = UiSlotKind.Absent;
    }

    findings.push({
      slot,
      kind,
      ...(computedValue !== undefined ? { computedValue } : {}),
      slotReferenced: referenced,
      valueRendered: rendered,
    });
  }

  return { findings, computedNotRendered, orphanSlots };
}
