import crypto from 'crypto';
import {
  createUserRecord,
  deleteUserRecord,
  getAllUsersList,
  getUserById,
  updateUserRecord,
} from './db.ts';

export interface CreatedUserCredential {
  id: number;
  displayName: string;
  username: string;
  password: string;
  role: 'user';
  createdAt: number;
}

const RESERVED_USERNAMES = new Set([
  'salim',
  'sami',
  'admin',
  'salim0',
  'salim00',
  'owner',
  'moderator',
  'mod',
  'root',
  'system',
  'support',
  'guest',
  'user',
  'test',
]);

const YEMENI_MALE_FIRST_NAMES = [
  'أحمد',
  'محمد',
  'علي',
  'عبدالله',
  'ياسر',
  'طارق',
  'ماهر',
  'وضاح',
  'نشوان',
  'غمدان',
  'مختار',
  'نبيل',
  'صقر',
  'رضوان',
  'معاذ',
  'بسام',
  'هيثم',
  'فيصل',
  'رامي',
  'عادل',
  'سمير',
  'حسام',
  'خالد',
  'سعيد',
  'صالح',
  'إبراهيم',
  'عمر',
  'زياد',
  'عمار',
  'أسامة',
  'منير',
  'شوقي',
  'عبده',
  'قاسم',
  'طه',
  'فؤاد',
  'أمين',
  'نادر',
  'مجاهد',
  'حسين',
  'يحيى',
  'ماجد',
];

const YEMENI_FEMALE_FIRST_NAMES = [
  'أروى',
  'بلقيس',
  'سمية',
  'سوسن',
  'أمل',
  'هدى',
  'ندى',
  'مروة',
  'ريم',
  'سارة',
  'شيماء',
  'وفاء',
  'أسماء',
  'خديجة',
  'منال',
  'إيمان',
  'فاطمة',
  'نجلاء',
  'سلمى',
  'رغد',
];

const YEMENI_SURNAMES = [
  'الحميري',
  'اليافعي',
  'الأغبري',
  'المقطري',
  'السقاف',
  'العولقي',
  'الإرياني',
  'الشرجبي',
  'الذماري',
  'الصنعاني',
  'العدني',
  'الحضرمي',
  'القدسي',
  'البيضاني',
  'الكميم',
  'الشبواني',
  'التهامي',
  'المحمدي',
  'العمودي',
  'باوزير',
  'بن محفوظ',
  'الوصابي',
  'الحاشدي',
  'البكيلي',
  'المأربي',
  'اللحجي',
  'المهري',
  'الخولاني',
  'السنحاني',
  'العماري',
  'الجبري',
  'الصلوي',
  'الزبيري',
  'الشيباني',
  'المطري',
  'السالمي',
  'النعمان',
  'الحداد',
];

const ARABIC_TO_LATIN_MAP: Record<string, string> = {
  أ: 'a',
  إ: 'i',
  آ: 'a',
  ا: 'a',
  ب: 'b',
  ت: 't',
  ث: 'th',
  ج: 'j',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ذ: 'dh',
  ر: 'r',
  ز: 'z',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  ة: 'a',
  و: 'w',
  ي: 'y',
  ى: 'a',
  ئ: 'y',
  ؤ: 'w',
  ء: '',
};

const KNOWN_YEMENI_WORD_LATIN: Record<string, string> = {
  احمد: 'ahmed',
  محمد: 'mohammed',
  علي: 'ali',
  عبدالله: 'abdullah',
  ياسر: 'yasser',
  طارق: 'tariq',
  ماهر: 'maher',
  وضاح: 'waddah',
  نشوان: 'nashwan',
  غمدان: 'ghamdan',
  مختار: 'mokhtar',
  نبيل: 'nabil',
  صقر: 'saqr',
  رضوان: 'radwan',
  معاذ: 'moath',
  بسام: 'bassam',
  هيثم: 'haitham',
  فيصل: 'faisal',
  رامي: 'rami',
  عادل: 'adel',
  سمير: 'samir',
  حسام: 'hussam',
  خالد: 'khaled',
  سعيد: 'saeed',
  صالح: 'saleh',
  ابراهيم: 'ibrahim',
  عمر: 'omar',
  زياد: 'ziyad',
  عمار: 'ammar',
  اسامه: 'osama',
  منير: 'munir',
  شوقي: 'shawqi',
  عبده: 'abdo',
  قاسم: 'qasim',
  طه: 'taha',
  فؤاد: 'fuad',
  امين: 'ameen',
  نادر: 'nader',
  مجاهد: 'mujahed',
  حسين: 'hussein',
  يحيي: 'yahya',
  ماجد: 'majed',
  اروي: 'arwa',
  بلقيس: 'balqees',
  سميه: 'sumaya',
  سوسن: 'sawsan',
  امل: 'amal',
  هدي: 'huda',
  ندي: 'nada',
  مروه: 'marwa',
  ريم: 'reem',
  ساره: 'sara',
  شيماء: 'shaima',
  وفاء: 'wafaa',
  اسماء: 'asmaa',
  خديجه: 'khadija',
  منال: 'manal',
  ايمان: 'iman',
  فاطمه: 'fatima',
  نجلاء: 'najla',
  سلمي: 'salma',
  رغد: 'raghad',
  الحميري: 'alhumairi',
  اليافعي: 'alyafei',
  الاغبري: 'alaghbari',
  المقطري: 'almaqtari',
  السقاف: 'alsaqqaf',
  العولقي: 'alawlaqi',
  الارياني: 'aleryani',
  الشرجبي: 'alsharjabi',
  الذماري: 'aldhamari',
  الصنعاني: 'alsanaani',
  العدني: 'aladani',
  الحضرمي: 'alhadrami',
  القدسي: 'alqudsi',
  البيضاني: 'albaidani',
  الكميم: 'alkumaim',
  الشبواني: 'alshabwani',
  التهامي: 'altihami',
  المحمدي: 'almohammadi',
  العمودي: 'alamoudi',
  باوزير: 'bawazeer',
  محفوظ: 'mahfoudh',
  الوصابي: 'alwasabi',
  الحاشدي: 'alhashidi',
  البكيلي: 'albakili',
  الماربي: 'almaribi',
  اللحجي: 'allahji',
  المهري: 'almahri',
  الخولاني: 'alkhawlani',
  السنحاني: 'alsanhani',
  العماري: 'alommari',
  الجبري: 'aljabri',
  الصلوي: 'alsalwi',
  الزبيري: 'alzubairi',
  الشيباني: 'alshaibani',
  المطري: 'almatari',
  السالمي: 'alsalmi',
  النعمان: 'alnuman',
  الحداد: 'alhaddad',
};

function normArabicSimple(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '');
}

export function transliterateArabicWordToEnglish(word: string): string {
  const clean = String(word || '').trim();
  if (!clean) return '';
  if (/^[a-zA-Z0-9_]+$/.test(clean)) return clean.toLowerCase();

  const norm = normArabicSimple(clean);
  if (KNOWN_YEMENI_WORD_LATIN[norm]) {
    return KNOWN_YEMENI_WORD_LATIN[norm];
  }

  let out = '';
  for (const ch of clean) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase();
    } else if (ARABIC_TO_LATIN_MAP[ch] !== undefined) {
      out += ARABIC_TO_LATIN_MAP[ch];
    }
  }
  return out.replace(/[^a-z0-9]/g, '');
}

export function generateUniqueEnglishUsername(
  displayName: string,
  takenLower: Set<string>
): string {
  const parts = String(displayName || '')
    .trim()
    .split(/\s+/)
    .map((p) => transliterateArabicWordToEnglish(p))
    .filter(Boolean);

  let base = parts.slice(0, 2).join('_');
  if (!base || !/^[a-z]/.test(base)) {
    base = `ym_${base || 'trader'}`;
  }
  base = base.replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').slice(0, 16);
  if (base.length < 4) {
    base = `${base}_ym`;
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const suffixNum = crypto.randomInt(10, 9999);
    const candidate = `${base}_${suffixNum}`.slice(0, 24);
    const lower = candidate.toLowerCase();
    if (!takenLower.has(lower) && !RESERVED_USERNAMES.has(lower)) {
      takenLower.add(lower);
      return candidate;
    }
  }

  const fallback = `ym_member_${crypto.randomBytes(3).toString('hex')}`;
  takenLower.add(fallback.toLowerCase());
  return fallback;
}

export function generateStrongRandomPassword(length = 12): string {
  const safeLen = Math.max(10, Math.min(24, Math.floor(length)));
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const all = upper + lower + digits + symbols;

  const chars: string[] = [
    upper[crypto.randomInt(0, upper.length)],
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    lower[crypto.randomInt(0, lower.length)],
    digits[crypto.randomInt(0, digits.length)],
    digits[crypto.randomInt(0, digits.length)],
    symbols[crypto.randomInt(0, symbols.length)],
    symbols[crypto.randomInt(0, symbols.length)],
  ];

  while (chars.length < safeLen) {
    chars.push(all[crypto.randomInt(0, all.length)]);
  }

  // Cryptographic Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }

  return chars.join('');
}

export function pickDiverseYemeniDisplayNames(
  count: number,
  existingDisplayNamesNorm: Set<string>,
  customNames?: string[]
): string[] {
  const results: string[] = [];
  const usedNorm = new Set(existingDisplayNamesNorm);

  if (Array.isArray(customNames)) {
    for (const raw of customNames) {
      if (results.length >= count) break;
      const clean = String(raw || '').trim().slice(0, 48);
      if (!clean) continue;
      const n = normArabicSimple(clean);
      if (!usedNorm.has(n)) {
        usedNorm.add(n);
        results.push(clean);
      } else {
        results.push(clean);
      }
    }
  }

  const allFirstNames = [
    ...YEMENI_MALE_FIRST_NAMES,
    ...YEMENI_FEMALE_FIRST_NAMES,
  ];

  let safety = 0;
  while (results.length < count && safety < 500) {
    safety++;
    // Mix ~70% male and ~30% female naturally
    const useFemale = crypto.randomInt(0, 10) < 3;
    const firstPool = useFemale ? YEMENI_FEMALE_FIRST_NAMES : YEMENI_MALE_FIRST_NAMES;
    const first = firstPool[crypto.randomInt(0, firstPool.length)];
    const surname = YEMENI_SURNAMES[crypto.randomInt(0, YEMENI_SURNAMES.length)];
    const full = `${first} ${surname}`;
    const norm = normArabicSimple(full);
    if (!usedNorm.has(norm)) {
      usedNorm.add(norm);
      results.push(full);
    } else if (safety > 300) {
      const altFirst = allFirstNames[crypto.randomInt(0, allFirstNames.length)];
      const fallbackName = `${altFirst} ${surname} ${results.length + 1}`;
      usedNorm.add(normArabicSimple(fallbackName));
      results.push(fallbackName);
    }
  }

  return results;
}

export function isProtectedOwnerOrSystemUser(user: {
  id: number;
  role?: string;
  username?: string;
  isRestrictedAdmin?: boolean;
}): boolean {
  const uid = Number(user.id);
  if (uid === 1 || uid === 76 || uid === 77) return true;
  if (user.isRestrictedAdmin) return true;
  if (String(user.role || '').toLowerCase() === 'owner') return true;
  const uname = String(user.username || '').trim().toLowerCase();
  return uname === 'salim' || uname === 'salim0' || uname === 'salim00';
}

export async function createUsersBatchViaAssistant(params: {
  count: number;
  customDisplayNames?: string[];
  customPassword?: string;
}): Promise<{
  created: CreatedUserCredential[];
  failed: Array<{ index: number; error: string }>;
}> {
  const safeCount = Math.max(1, Math.min(30, Math.floor(Number(params.count) || 1)));
  const existingUsers = await getAllUsersList();

  const takenUsernames = new Set<string>();
  const existingDisplayNamesNorm = new Set<string>();
  for (const u of existingUsers) {
    if (u.username) takenUsernames.add(String(u.username).trim().toLowerCase());
    if (u.displayName) existingDisplayNamesNorm.add(normArabicSimple(u.displayName));
  }

  const displayNames = pickDiverseYemeniDisplayNames(
    safeCount,
    existingDisplayNamesNorm,
    params.customDisplayNames
  );

  const singleCustomPass =
    safeCount === 1 && params.customPassword && String(params.customPassword).trim().length >= 4
      ? String(params.customPassword).trim()
      : null;

  const created: CreatedUserCredential[] = [];
  const failed: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < displayNames.length; i++) {
    const displayName = displayNames[i];
    const username = generateUniqueEnglishUsername(displayName, takenUsernames);
    const password = singleCustomPass || generateStrongRandomPassword(12);

    try {
      const record = await createUserRecord({
        username,
        displayName,
        password,
        role: 'user',
      });
      created.push({
        id: Number(record.id),
        displayName: record.displayName,
        username: record.username,
        password,
        role: 'user',
        createdAt: Number(record.createdAt || Date.now()),
      });
    } catch (err: any) {
      failed.push({
        index: i + 1,
        error: err?.message || 'فشل إنشاء الحساب في قاعدة البيانات.',
      });
    }
  }

  return { created, failed };
}

export async function updateRegularUserByAssistant(params: {
  userId: number;
  displayName?: string;
  password?: string;
  generateRandomPassword?: boolean;
  warningsCount?: number;
}): Promise<{
  id: number;
  username: string;
  displayName: string;
  role: string;
  warningsCount: number;
  newPassword?: string;
}> {
  const target = await getUserById(Number(params.userId));
  if (!target) {
    throw new Error('المستخدم غير موجود.');
  }
  if (isProtectedOwnerOrSystemUser(target)) {
    throw new Error('لا يمكن تعديل حساب المالك الرئيسي أو حسابات الإدارة المقيدة عبر المساعد.');
  }

  let nextPass: string | undefined;
  if (params.generateRandomPassword) {
    nextPass = generateStrongRandomPassword(12);
  } else if (params.password && String(params.password).trim()) {
    nextPass = String(params.password).trim();
  }

  const updated = await updateUserRecord(target.id, {
    ...(params.displayName !== undefined ? { displayName: String(params.displayName).trim() } : {}),
    ...(nextPass !== undefined ? { password: nextPass } : {}),
    ...(params.warningsCount !== undefined ? { warningsCount: Math.max(0, Math.floor(Number(params.warningsCount) || 0)) } : {}),
  });

  if (!updated) {
    throw new Error('تعذر تحديث بيانات المستخدم.');
  }

  return {
    id: Number(updated.id),
    username: updated.username,
    displayName: updated.displayName,
    role: updated.role,
    warningsCount: Number(updated.warningsCount || 0),
    ...(nextPass !== undefined ? { newPassword: nextPass } : {}),
  };
}

export async function deleteRegularUserByAssistant(userId: number): Promise<{
  id: number;
  username: string;
  displayName: string;
}> {
  const target = await getUserById(Number(userId));
  if (!target) {
    throw new Error('المستخدم غير موجود.');
  }
  if (isProtectedOwnerOrSystemUser(target)) {
    throw new Error('محظور: لا يمكن حذف حساب المالك الرئيسي أو الحسابات المحمية.');
  }

  await deleteUserRecord(target.id);
  return {
    id: Number(target.id),
    username: target.username,
    displayName: target.displayName,
  };
}
