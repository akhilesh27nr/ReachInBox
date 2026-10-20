/**
 * Email template dynamic variable interpolation and tag helpers
 * Supports {{name}}, {{company}}, {{jobTitle}}, {{email}}
 */

export interface LeadVariables {
  email: string;
  name?: string;
  company?: string;
  jobTitle?: string;
}

export interface VariableDefinition {
  tag: string;
  key: keyof LeadVariables;
  label: string;
  description: string;
  example: string;
  badgeColor: string;
}

export const COMMON_TEMPLATE_VARIABLES: VariableDefinition[] = [
  {
    tag: '{{name}}',
    key: 'name',
    label: 'Recipient Name',
    description: 'First or full name (e.g., extracted from email handle or CSV)',
    example: 'Sarah Jenkins',
    badgeColor: 'bg-indigo-950/80 text-indigo-300 border-indigo-500/40',
  },
  {
    tag: '{{company}}',
    key: 'company',
    label: 'Company Name',
    description: 'Organization name inferred from domain or lead record',
    example: 'Stripe',
    badgeColor: 'bg-teal-950/80 text-teal-300 border-teal-500/40',
  },
  {
    tag: '{{jobTitle}}',
    key: 'jobTitle',
    label: 'Job Title',
    description: 'Professional role or title of the prospect',
    example: 'VP of Growth',
    badgeColor: 'bg-purple-950/80 text-purple-300 border-purple-500/40',
  },
  {
    tag: '{{email}}',
    key: 'email',
    label: 'Email Address',
    description: 'Full destination email address of the lead',
    example: 'sarah.jenkins@stripe.com',
    badgeColor: 'bg-cyan-950/80 text-cyan-300 border-cyan-500/40',
  },
];

/**
 * Intelligently infers name, company, and job title from an email address when metadata is omitted.
 */
export function inferLeadVariables(email: string, partial?: Partial<LeadVariables>): LeadVariables {
  const safeEmail = (email || '').trim().toLowerCase();

  // 1. Inferred name from email prefix (e.g. sarah.smith -> Sarah Smith, k_hall -> K Hall, etc.)
  let inferredName = 'Valued Partner';
  const localPart = safeEmail.split('@')[0] || '';
  if (localPart) {
    const parts = localPart.split(/[._-]/).filter(Boolean);
    if (parts.length > 0) {
      inferredName = parts
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
    }
  }

  // 2. Inferred company from email domain (e.g. stripe.com -> Stripe, hubspot.com -> HubSpot)
  let inferredCompany = 'Your Team';
  const domain = safeEmail.split('@')[1] || '';
  if (domain) {
    const domainName = domain.split('.')[0] || '';
    const genericProviders = ['gmail', 'yahoo', 'outlook', 'hotmail', 'proton', 'icloud', 'mail'];
    if (domainName && !genericProviders.includes(domainName.toLowerCase())) {
      if (domainName.toLowerCase() === 'hubspot') inferredCompany = 'HubSpot';
      else if (domainName.toLowerCase() === 'airbnb') inferredCompany = 'Airbnb';
      else if (domainName.toLowerCase() === 'snowflake') inferredCompany = 'Snowflake';
      else if (domainName.toLowerCase() === 'segment') inferredCompany = 'Segment';
      else inferredCompany = domainName.charAt(0).toUpperCase() + domainName.slice(1);
    }
  }

  // 3. Inferred role
  const inferredRole = 'Team Lead';

  return {
    email: safeEmail || 'lead@example.com',
    name: partial?.name?.trim() || inferredName,
    company: partial?.company?.trim() || inferredCompany,
    jobTitle: partial?.jobTitle?.trim() || inferredRole,
  };
}

/**
 * Interpolates all supported dynamic variables into a template string:
 * {{email}}, {{name}}, {{company}}, {{jobTitle}} (case and whitespace-tolerant)
 */
export function renderEmailTemplate(template: string, lead: string | LeadVariables): string {
  if (!template) return '';
  const variables: LeadVariables =
    typeof lead === 'string' ? inferLeadVariables(lead) : inferLeadVariables(lead.email, lead);

  return template
    .replace(/\{\{\s*email\s*\}\}/gi, variables.email)
    .replace(/\{\{\s*name\s*\}\}/gi, variables.name || 'there')
    .replace(/\{\{\s*company\s*\}\}/gi, variables.company || 'your team')
    .replace(/\{\{\s*(jobTitle|job_title|jobtitle|title)\s*\}\}/gi, variables.jobTitle || 'leader');
}

/**
 * Detects presence and count of all dynamic variable tags in a template.
 */
export function detectTemplateTags(template: string): {
  hasTags: boolean;
  hasEmailTag: boolean;
  hasNameTag: boolean;
  hasCompanyTag: boolean;
  hasJobTitleTag: boolean;
  tagCount: number;
  detectedTags: string[];
} {
  if (!template) {
    return {
      hasTags: false,
      hasEmailTag: false,
      hasNameTag: false,
      hasCompanyTag: false,
      hasJobTitleTag: false,
      tagCount: 0,
      detectedTags: [],
    };
  }

  const emailMatches = template.match(/\{\{\s*email\s*\}\}/gi) || [];
  const nameMatches = template.match(/\{\{\s*name\s*\}\}/gi) || [];
  const companyMatches = template.match(/\{\{\s*company\s*\}\}/gi) || [];
  const jobTitleMatches = template.match(/\{\{\s*(jobTitle|job_title|jobtitle|title)\s*\}\}/gi) || [];

  const detected: string[] = [];
  if (emailMatches.length > 0) detected.push('{{email}}');
  if (nameMatches.length > 0) detected.push('{{name}}');
  if (companyMatches.length > 0) detected.push('{{company}}');
  if (jobTitleMatches.length > 0) detected.push('{{jobTitle}}');

  const total = emailMatches.length + nameMatches.length + companyMatches.length + jobTitleMatches.length;

  return {
    hasTags: total > 0,
    hasEmailTag: emailMatches.length > 0,
    hasNameTag: nameMatches.length > 0,
    hasCompanyTag: companyMatches.length > 0,
    hasJobTitleTag: jobTitleMatches.length > 0,
    tagCount: total,
    detectedTags: detected,
  };
}
