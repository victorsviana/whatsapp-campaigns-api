const BRAZIL_COUNTRY_CODE = '55';
const VALID_PHONE_PATTERN = /^55[1-9]{2}(?:9\d{8}|\d{8})$/;

export type PhoneResult =
  | { ok: true; phone: string }
  | { ok: false; reason: 'missing_phone' | 'invalid_phone' };

export function normalizePhone(raw: unknown): PhoneResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'missing_phone' };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, reason: 'invalid_phone' };
  }

  const text = String(raw);
  if (text.trim() === '') {
    return { ok: false, reason: 'missing_phone' };
  }

  let digits = text.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) {
    digits = BRAZIL_COUNTRY_CODE + digits;
  }

  if (!VALID_PHONE_PATTERN.test(digits)) {
    return { ok: false, reason: 'invalid_phone' };
  }
  return { ok: true, phone: `+${digits}` };
}

export type ContactInput = {
  phone?: unknown;
  variables?: unknown;
};

export type AcceptedContact = {
  phone: string;
  variables: Record<string, string>;
};

export type RejectedContact =
  | { index: number; phone: unknown; reason: 'missing_phone' | 'invalid_phone' | 'duplicate_phone' }
  | { index: number; phone: unknown; reason: 'missing_variables'; missing: string[] };

export type ContactValidationResult = {
  accepted: AcceptedContact[];
  rejected: RejectedContact[];
};

export function validateContacts(
  contacts: ContactInput[],
  templateVariables: string[],
  alreadyAcceptedPhones: ReadonlySet<string> = new Set(),
): ContactValidationResult {
  const acceptedPhones = new Set(alreadyAcceptedPhones);
  const accepted: AcceptedContact[] = [];
  const rejected: RejectedContact[] = [];

  contacts.forEach((contact, index) => {
    const rawPhone = contact.phone ?? null;

    const phoneResult = normalizePhone(rawPhone);
    if (!phoneResult.ok) {
      rejected.push({ index, phone: rawPhone, reason: phoneResult.reason });
      return;
    }

    const { values, missing } = pickVariables(contact.variables, templateVariables);
    if (missing.length > 0) {
      rejected.push({ index, phone: rawPhone, reason: 'missing_variables', missing });
      return;
    }

    if (acceptedPhones.has(phoneResult.phone)) {
      rejected.push({ index, phone: rawPhone, reason: 'duplicate_phone' });
      return;
    }

    acceptedPhones.add(phoneResult.phone);
    accepted.push({ phone: phoneResult.phone, variables: values });
  });

  return { accepted, rejected };
}

function pickVariables(
  raw: unknown,
  templateVariables: string[],
): { values: Record<string, string>; missing: string[] } {
  const source = isPlainObject(raw) ? raw : {};
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of templateVariables) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      values[name] = String(value);
    } else if (typeof value === 'string' && value.trim() !== '') {
      values[name] = value;
    } else {
      missing.push(name);
    }
  }

  return { values, missing };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
