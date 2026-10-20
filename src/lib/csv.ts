/**
 * Pure RFC-4180 CSV & Recipient Lead Parser (Prompt 16)
 * Handles UTF-8 BOM, headers, quoted commas, multiline fields, escaped quotes,
 * empty rows, malformed quotes, invalid email syntax, and duplicate detection.
 */

export interface ParsedLeadRecord {
  email: string;
  name?: string;
  company?: string;
  jobTitle?: string;
  rowNumber: number;
}

export interface CsvLeadParseResult {
  validLeads: ParsedLeadRecord[];
  validEmails: string[];
  duplicateEmails: string[];
  invalidEntries: string[];
  malformedRows: string[];
  totalRowsRead: number;
  hasHeader: boolean;
}

const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidLeadEmail(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return false;
  if (trimmed.includes('..') || trimmed.startsWith('.') || trimmed.endsWith('.')) return false;
  const [local, domain] = trimmed.split('@');
  if (!local || !domain || local.length > 64) return false;
  if (domain.startsWith('-') || domain.endsWith('-') || domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }
  return STRICT_EMAIL_REGEX.test(trimmed);
}

/**
 * Low-level RFC-4180 CSV tokenizer supporting quoted commas, escaped quotes (""),
 * CRLF/LF newlines inside quotes, and malformed quote detection.
 */
export function parseRawCsvMatrix(rawText: string): {
  rows: string[][];
  malformedRows: string[];
} {
  // Strip UTF-8 BOM if present
  const cleanText = rawText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  const malformedRows: string[] = [];

  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let rowIndex = 1;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const next = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (currentCell.trim().length === 0) {
        currentCell = '';
        inQuotes = true;
      } else {
        // Quote appearing mid-unquoted-field: record as malformed but continue
        malformedRows.push(`Row ${rowIndex}: Unexpected quote in unquoted field`);
        currentCell += ch;
      }
      continue;
    }

    if (ch === ',' || ch === ';' || ch === '\t') {
      currentRow.push(currentCell.trim());
      currentCell = '';
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && next === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
      rowIndex++;
      continue;
    }

    currentCell += ch;
  }

  if (inQuotes) {
    malformedRows.push(`Row ${rowIndex}: Unclosed quoted field at end of input`);
  }

  if (currentCell.trim().length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c.length > 0)) {
      rows.push(currentRow);
    }
  }

  return { rows, malformedRows };
}

const EMAIL_HEADER_NAMES = new Set([
  'email',
  'e-mail',
  'email_address',
  'emailaddress',
  'recipient',
  'to',
  'to_email',
  'lead_email',
  'work_email',
]);

const NAME_HEADER_NAMES = new Set([
  'name',
  'full_name',
  'fullname',
  'recipient_name',
  'contact_name',
  'first_name',
  'firstname',
]);

const COMPANY_HEADER_NAMES = new Set([
  'company',
  'company_name',
  'organization',
  'org',
  'account',
]);

const TITLE_HEADER_NAMES = new Set([
  'title',
  'job_title',
  'jobtitle',
  'role',
  'position',
]);

function normalizeHeaderKey(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/[\s-]+/g, '_');
}

export function parseLeadsCsvText(
  rawText: string,
  options?: { maxLeads?: number }
): CsvLeadParseResult {
  const maxLeads = options?.maxLeads ?? 20000;
  if (!rawText || !rawText.trim()) {
    return {
      validLeads: [],
      validEmails: [],
      duplicateEmails: [],
      invalidEntries: [],
      malformedRows: [],
      totalRowsRead: 0,
      hasHeader: false,
    };
  }

  const { rows, malformedRows } = parseRawCsvMatrix(rawText);
  if (rows.length === 0) {
    return {
      validLeads: [],
      validEmails: [],
      duplicateEmails: [],
      invalidEntries: [],
      malformedRows,
      totalRowsRead: 0,
      hasHeader: false,
    };
  }

  let hasHeader = false;
  let emailColIdx = -1;
  let nameColIdx = -1;
  let companyColIdx = -1;
  let titleColIdx = -1;

  const firstRow = rows[0];
  const firstRowHasEmail = firstRow.some((cell) => isValidLeadEmail(cell));

  if (!firstRowHasEmail) {
    firstRow.forEach((cell, idx) => {
      const norm = normalizeHeaderKey(cell);
      if (EMAIL_HEADER_NAMES.has(norm) && emailColIdx === -1) {
        emailColIdx = idx;
        hasHeader = true;
      } else if (NAME_HEADER_NAMES.has(norm) && nameColIdx === -1) {
        nameColIdx = idx;
        hasHeader = true;
      } else if (COMPANY_HEADER_NAMES.has(norm) && companyColIdx === -1) {
        companyColIdx = idx;
        hasHeader = true;
      } else if (TITLE_HEADER_NAMES.has(norm) && titleColIdx === -1) {
        titleColIdx = idx;
        hasHeader = true;
      }
    });
  }

  const startRow = hasHeader ? 1 : 0;
  const seenEmails = new Set<string>();
  const validLeads: ParsedLeadRecord[] = [];
  const validEmails: string[] = [];
  const duplicateEmails: string[] = [];
  const invalidEntries: string[] = [];

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !c.trim())) continue;

    let candidateEmail = '';
    if (emailColIdx >= 0 && emailColIdx < row.length) {
      candidateEmail = row[emailColIdx].trim();
    } else {
      // Find first cell that looks like an email or contains @, or fallback to first non-empty cell
      const emailCell = row.find((c) => isValidLeadEmail(c)) || row.find((c) => c.includes('@')) || row[0] || '';
      candidateEmail = emailCell.trim();
    }

    // Strip surrounding angle brackets if formatted as "Name <email@domain.com>"
    const angleMatch = candidateEmail.match(/<([^>]+)>/);
    if (angleMatch) {
      candidateEmail = angleMatch[1].trim();
    }

    const normalizedEmail = candidateEmail.toLowerCase();

    if (!isValidLeadEmail(normalizedEmail)) {
      if (candidateEmail) {
        invalidEntries.push(candidateEmail);
      }
      continue;
    }

    if (seenEmails.has(normalizedEmail)) {
      duplicateEmails.push(normalizedEmail);
      continue;
    }

    if (validLeads.length >= maxLeads) {
      malformedRows.push(`Exceeded maximum allowed leads (${maxLeads})`);
      break;
    }

    seenEmails.add(normalizedEmail);
    validEmails.push(normalizedEmail);

    const record: ParsedLeadRecord = {
      email: normalizedEmail,
      rowNumber: r + 1,
    };

    if (nameColIdx >= 0 && row[nameColIdx]?.trim()) {
      record.name = row[nameColIdx].trim();
    }
    if (companyColIdx >= 0 && row[companyColIdx]?.trim()) {
      record.company = row[companyColIdx].trim();
    }
    if (titleColIdx >= 0 && row[titleColIdx]?.trim()) {
      record.jobTitle = row[titleColIdx].trim();
    }

    validLeads.push(record);
  }

  return {
    validLeads,
    validEmails,
    duplicateEmails,
    invalidEntries,
    malformedRows,
    totalRowsRead: Math.max(0, rows.length - startRow),
    hasHeader,
  };
}
