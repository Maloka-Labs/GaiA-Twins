/**
 * GaiA Governance Gate — Constitutional Safety Layer
 *
 * Thin abstraction between Telegram handler and Gemini inference.
 * Implements LOVEval pre/post filters for:
 *   - Medical advice boundaries
 *   - Crisis/self-harm detection and redirect
 *   - Injury risk flagging
 *   - Scope limitation enforcement
 *
 * Tim & Zen Directive §3: "Even a simple rules-based pre/post filter
 * that checks for medical advice boundaries, injury risk, and scope
 * limitations would be enough to demonstrate that constitutional
 * governance isn't just planned — it's operating."
 */

import { logger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────────

export interface GateResult {
    allowed: boolean;
    modifiedText?: string;
    flags: string[];
    reason?: string;
    redirectMessage?: string;
}

export interface GovernanceConfig {
    practitioner: string;
    enablePreFilter: boolean;
    enablePostFilter: boolean;
}

// ─── Crisis Patterns ─────────────────────────────────────────────

const CRISIS_PATTERNS = [
    /\b(suicid|kill\s*my\s*self|end\s*(my|it\s*all)|want\s*to\s*die|self[\s-]*harm)\b/i,
    /\b(overdose|hurt\s*myself|cutting\s*myself)\b/i,
    /\b(no\s*reason\s*to\s*live|better\s*off\s*dead)\b/i,
];

const CRISIS_REDIRECT = `💙 I hear you, and I want you to know that what you're feeling matters deeply. This is beyond what I can help with as an AI wellness guide — please reach out to someone who can truly support you right now:

• *988 Suicide & Crisis Lifeline* — Call or text 988 (US)
• *Crisis Text Line* — Text HOME to 741741
• *International:* findahelpline.com

You deserve real, human support. Please reach out. 🤍`;

// ─── Medical Diagnosis Patterns ──────────────────────────────────

const MEDICAL_DIAGNOSIS_PATTERNS = [
    /\b(diagnos|prescri|what\s*medication|should\s*i\s*take|what\s*drug)\b/i,
    /\b(am\s*i\s*(sick|ill|dying)|do\s*i\s*have\s*(cancer|diabetes|disease))\b/i,
    /\b(replace\s*(my\s*)?doctor|instead\s*of\s*(seeing\s*)?(a\s*)?doctor)\b/i,
];

const MEDICAL_DISCLAIMER =
    '\n\n_Note: I\'m an AI wellness guide, not a medical professional. For specific health concerns, please consult your healthcare provider._ 🏥';

// ─── Injury Risk Patterns ────────────────────────────────────────

const INJURY_RISK_PATTERNS = [
    /\b(herniated\s*disc|slipped\s*disc|torn\s*(acl|mcl|meniscus|rotator))\b/i,
    /\b(broken\s*bone|fracture|sprain|concussion)\b/i,
    /\b(pregnant|pregnanc|trimester)\b/i,
    /\b(heart\s*condition|high\s*blood\s*pressure|hypertension)\b/i,
];

const INJURY_SAFETY_NOTE =
    '\n\n⚠️ _Given your condition, please clear any new exercise with your doctor or physical therapist first. Safety comes first!_';

// ─── Financial/Legal Patterns ────────────────────────────────────

const OUT_OF_SCOPE_PATTERNS = [
    /\b(invest|stock|crypto|bitcoin|financ|tax|legal\s*advice|lawsuit|attorney)\b/i,
];

// ─── Pre-Filter ──────────────────────────────────────────────────

export function preFilter(
    userMessage: string,
    config: GovernanceConfig,
): GateResult {
    if (!config.enablePreFilter) {
        return { allowed: true, flags: [] };
    }

    const flags: string[] = [];

    // 1. CRISIS DETECTION — highest priority
    for (const pattern of CRISIS_PATTERNS) {
        if (pattern.test(userMessage)) {
            logger.warn(
                { practitioner: config.practitioner },
                'LOVEval Gate: Crisis language detected — redirecting to professional support',
            );
            return {
                allowed: false,
                flags: ['CRISIS_DETECTED'],
                reason: 'Crisis language detected',
                redirectMessage: CRISIS_REDIRECT,
            };
        }
    }

    // 2. OUT-OF-SCOPE — politely redirect
    for (const pattern of OUT_OF_SCOPE_PATTERNS) {
        if (pattern.test(userMessage)) {
            flags.push('OUT_OF_SCOPE');
            logger.info(
                { practitioner: config.practitioner },
                'LOVEval Gate: Out-of-scope query detected',
            );
        }
    }

    // 3. MEDICAL DIAGNOSIS REQUEST — allow but flag
    for (const pattern of MEDICAL_DIAGNOSIS_PATTERNS) {
        if (pattern.test(userMessage)) {
            flags.push('MEDICAL_QUERY');
            logger.info(
                { practitioner: config.practitioner },
                'LOVEval Gate: Medical query detected — will add disclaimer',
            );
        }
    }

    // 4. INJURY RISK — allow but flag
    for (const pattern of INJURY_RISK_PATTERNS) {
        if (pattern.test(userMessage)) {
            flags.push('INJURY_RISK');
            logger.info(
                { practitioner: config.practitioner },
                'LOVEval Gate: Injury/condition risk detected — will add safety note',
            );
        }
    }

    return { allowed: true, flags };
}

// ─── Post-Filter ─────────────────────────────────────────────────

export function postFilter(
    response: string,
    preFlags: string[],
    config: GovernanceConfig,
): GateResult {
    if (!config.enablePostFilter) {
        return { allowed: true, flags: preFlags, modifiedText: response };
    }

    let modifiedText = response;
    const flags = [...preFlags];

    // 1. If medical query was flagged, ensure disclaimer exists
    if (preFlags.includes('MEDICAL_QUERY')) {
        const hasDisclaimer = /consult|healthcare|doctor|medical\s*professional/i.test(response);
        if (!hasDisclaimer) {
            modifiedText += MEDICAL_DISCLAIMER;
            flags.push('DISCLAIMER_ADDED');
            logger.info('LOVEval Gate: Added medical disclaimer to response');
        }
    }

    // 2. If injury risk was flagged, add safety note
    if (preFlags.includes('INJURY_RISK')) {
        const hasSafetyNote = /clear\s*with|consult|doctor|physical\s*therapist|safety/i.test(response);
        if (!hasSafetyNote) {
            modifiedText += INJURY_SAFETY_NOTE;
            flags.push('SAFETY_NOTE_ADDED');
            logger.info('LOVEval Gate: Added injury safety note to response');
        }
    }

    // 3. Scan for any specific medication recommendations that slipped through
    const medPrescriptionPattern = /\b(take|use|try)\s+\d+\s*mg\s+of\s+\w+/i;
    if (medPrescriptionPattern.test(response)) {
        modifiedText += MEDICAL_DISCLAIMER;
        flags.push('PRESCRIPTION_LANGUAGE_CAUGHT');
        logger.warn('LOVEval Gate: Prescription-like language caught in response');
    }

    return { allowed: true, flags, modifiedText };
}

// ─── Convenience: Full Pipeline ──────────────────────────────────

export function createGovernanceGate(practitioner: string) {
    const config: GovernanceConfig = {
        practitioner,
        enablePreFilter: true,
        enablePostFilter: true,
    };

    return {
        /** Run before sending to LLM */
        checkInput: (message: string) => preFilter(message, config),
        /** Run after receiving from LLM */
        checkOutput: (response: string, preFlags: string[]) =>
            postFilter(response, preFlags, config),
        config,
    };
}
