/**
 * Assess recorded evidence, not pixels. The caller must inspect the cited source.
 * This module prevents unsupported observations from becoming shortlist matches.
 */
const METHODS = new Set(['visual', 'specific_text', 'amenity_label']);
const VALUES = new Set(['yes', 'no', 'unknown']);
const SOURCE_TYPES = new Set(['photo', 'listing', 'host']);
const WORKSPACE_CRITERIA = ['stable_surface', 'laptop_space', 'compatible_seat', 'legroom'];

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}
function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO date-time`);
  }
  return Date.parse(value);
}
function unique(values, field) {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${field}`);
}
export function workspaceRequirement({ required = true } = {}) {
  return { id: 'workspace', required, criteria: [...WORKSPACE_CRITERIA] };
}

export function assess(packet, requirementsOverride) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new Error('assessment input must be an object');
  }
  const listingId = nonempty(packet.listing_id, 'listing_id');
  const requirements = requirementsOverride ?? packet.requirements;
  if (!Array.isArray(requirements) || !requirements.length || requirements.length > 50) {
    throw new Error('requirements must contain 1 to 50 entries');
  }
  for (const r of requirements) {
    nonempty(r.id, 'requirement id');
    if (typeof r.required !== 'boolean') throw new Error('requirement.required must be boolean');
    if (!Array.isArray(r.criteria) || !r.criteria.length || r.criteria.length > 20) {
      throw new Error('requirement criteria must contain 1 to 20 names');
    }
    r.criteria.forEach(c => nonempty(c, 'criterion'));
    unique(r.criteria, 'criteria');
    if (r.allowed_methods && (!Array.isArray(r.allowed_methods) || !r.allowed_methods.length ||
        r.allowed_methods.some(m => !METHODS.has(m)))) {
      throw new Error('allowed_methods must contain known evidence methods');
    }
    if (r.max_age_hours !== undefined && (!Number.isFinite(r.max_age_hours) || r.max_age_hours < 0)) {
      throw new Error('max_age_hours must be a nonnegative number');
    }
  }
  unique(requirements.map(r => r.id), 'requirement ids');
  unique(requirements.flatMap(r => r.criteria), 'criterion ids across requirements');
  const evidence = packet.evidence ?? [];
  if (!Array.isArray(evidence)) throw new Error('evidence must be an array');
  const asOf = packet.as_of ? timestamp(packet.as_of, 'as_of') : Date.now();
  const warnings = [];
  const usable = [];
  for (const e of evidence) {
    nonempty(e.id, 'evidence id');
    nonempty(e.listing_id, 'evidence listing_id');
    if (!METHODS.has(e.method)) throw new Error(`unknown evidence method: ${e.method}`);
    if (!e.source || !SOURCE_TYPES.has(e.source.type) ||
        !(typeof e.source.url === 'string' && e.source.url.trim() ||
          typeof e.source.file === 'string' && e.source.file.trim())) {
      throw new Error('evidence source needs type and a URL or file');
    }
    if (e.method === 'visual' && e.source.type !== 'photo') {
      throw new Error('visual evidence requires a photo source');
    }
    const observed = timestamp(e.observed_at, 'observed_at');
    if (!Array.isArray(e.observations) || !e.observations.length) {
      throw new Error('evidence observations must be nonempty');
    }
    for (const o of e.observations) {
      nonempty(o.criterion, 'observation criterion');
      if (!VALUES.has(o.value)) throw new Error(`observation value must be yes, no or unknown: ${o.value}`);
      nonempty(o.detail, 'observation detail');
    }
    if (e.listing_id !== listingId) {
      warnings.push(`${e.id}: evidence belongs to another listing; ignored`);
      continue;
    }
    if (observed > asOf + 60_000) {
      warnings.push(`${e.id}: observed_at is later than assessment time; ignored`);
      continue;
    }
    if (e.expires_at && timestamp(e.expires_at, 'expires_at') < asOf) {
      warnings.push(`${e.id}: evidence expired; ignored`);
      continue;
    }
    usable.push(e);
  }
  unique(evidence.map(e => e.id), 'evidence ids');

  const results = requirements.map(r => {
    const allowed = r.allowed_methods ?? ['visual', 'specific_text'];
    const checks = r.criteria.map(criterion => {
      const observations = [];
      for (const e of usable) {
        const physicalWorkspace = WORKSPACE_CRITERIA.includes(criterion) || criterion === 'standing_height';
        if (!allowed.includes(e.method) || (physicalWorkspace && e.method === 'amenity_label')) continue;
        if (r.max_age_hours !== undefined &&
            asOf - Date.parse(e.observed_at) > r.max_age_hours * 3_600_000) continue;
        for (const o of e.observations.filter(x => x.criterion === criterion)) {
          observations.push({
            evidence_id: e.id, value: o.value, detail: o.detail, method: e.method,
          });
        }
      }
      const yes = observations.some(o => o.value === 'yes');
      const no = observations.some(o => o.value === 'no');
      const status = yes && no ? 'conflict' : no ? 'not_met' : yes ? 'met' : 'unknown';
      return { criterion, status, observations };
    });
    const statuses = checks.map(c => c.status);
    const status = statuses.includes('conflict') ? 'conflict' :
      statuses.includes('not_met') ? 'not_met' :
      statuses.every(s => s === 'met') ? 'met' : 'unknown';
    return {
      id: r.id, required: r.required, status, criteria: checks,
      missing: checks.filter(c => c.status === 'unknown').map(c => c.criterion),
      evidence_ids: [...new Set(checks.flatMap(c => c.observations.map(o => o.evidence_id)))],
    };
  });
  const required = results.filter(r => r.required);
  const eligible = required.length > 0 && required.every(r => r.status === 'met');
  if (!required.length) warnings.push('No required conditions were supplied; no verified match can be established');
  const status = eligible ? 'verified_match' :
    required.some(r => r.status === 'not_met') ? 'not_met' : 'needs_evidence';
  return {
    listing_id: listingId, basis: 'assessment_of_supplied_evidence',
    as_of: new Date(asOf).toISOString(), status, eligible,
    requirements: results, evidence, warnings,
    limitations: [
      'This checks recorded observations; it does not inspect images or independently authenticate the evidence.',
      'A visible laptop setup does not establish exact dimensions, sustained comfort, Wi-Fi speed or power access.',
    ],
  };
}
export const assessRequirements = assess;
export default assess;
