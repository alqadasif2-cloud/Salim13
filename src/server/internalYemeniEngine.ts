import crypto from 'crypto';

export interface InternalPersonaDraftItem {
  id: string;
  personaName: string;
  dialect: string;
  styleTag: string;
  text: string;
}

interface TopicContext {
  profitText: string | null;
  assetText: string | null;
  isLoss: boolean;
  isAnalysis: boolean;
  isProfit: boolean;
  isRequestTrades: boolean;
  isRequestGeneral: boolean;
  isQuestion: boolean;
  isThanks: boolean;
  addressedPerson: string;
  requestedPhrase: string | null;
  questionPhrase: string | null;
  channelRef: string | null;
  topicSnippet: string | null;
  rawTopicClean: string;
}

const YEMENI_PERSONA_POOL: Array<{ name: string; dialect: string; gender: 'm' | 'f' }> = [
  { name: 'أبو حمير الصنعاني', dialect: 'صنعاني', gender: 'm' },
  { name: 'بلقيس اليافعي', dialect: 'يافعي', gender: 'f' },
  { name: 'ماهر العولقي', dialect: 'حضرمي', gender: 'm' },
  { name: 'سوسن العدني', dialect: 'عدني', gender: 'f' },
  { name: 'غمدان المقطري', dialect: 'تعزي', gender: 'm' },
  { name: 'أروى الصنعاني', dialect: 'صنعاني', gender: 'f' },
  { name: 'عبده القدسي', dialect: 'تعزي', gender: 'm' },
  { name: 'سمية الحضرمي', dialect: 'حضرمي', gender: 'f' },
  { name: 'وضاح الأغبري', dialect: 'إبّي', gender: 'm' },
  { name: 'نشوان السقاف', dialect: 'عدني', gender: 'm' },
  { name: 'أمل الكميم', dialect: 'صنعاني', gender: 'f' },
  { name: 'صقر الشبواني', dialect: 'حضرمي', gender: 'm' },
  { name: 'مختار الذماري', dialect: 'صنعاني', gender: 'm' },
  { name: 'هدى البيضاني', dialect: 'إبّي', gender: 'f' },
  { name: 'طه الشرجبي', dialect: 'تعزي', gender: 'm' },
  { name: 'رضوان التهامي', dialect: 'فصحى يمنية', gender: 'm' },
  { name: 'نبيل الإرياني', dialect: 'إبّي', gender: 'm' },
  { name: 'قاسم الحميري', dialect: 'يافعي', gender: 'm' },
  { name: 'ندى العماري', dialect: 'عدني', gender: 'f' },
  { name: 'صالح باوزير', dialect: 'حضرمي', gender: 'm' },
  { name: 'فيصل الوصابي', dialect: 'إبّي', gender: 'm' },
  { name: 'مروة المخلافي', dialect: 'تعزي', gender: 'f' },
  { name: 'طلال الحاشدي', dialect: 'صنعاني', gender: 'm' },
  { name: 'ريم السالمي', dialect: 'فصحى يمنية', gender: 'f' },
  { name: 'سعيد المأربي', dialect: 'حضرمي', gender: 'm' },
  { name: 'هيثم الصلوي', dialect: 'تعزي', gender: 'm' },
  { name: 'منال اللحجي', dialect: 'عدني', gender: 'f' },
  { name: 'معاذ المطري', dialect: 'صنعاني', gender: 'm' },
  { name: 'شيماء الكاف', dialect: 'حضرمي', gender: 'f' },
  { name: 'بسام الزبيري', dialect: 'يافعي', gender: 'm' },
];

const FALLBACK_SURNAMES = [
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
];

function normMatch(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '');
}

function pickRandom<T>(arr: T[]): T {
  return arr[crypto.randomInt(0, arr.length)];
}

function shuffleArr<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function toAsciiDigits(s: string): string {
  return String(s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function analyzeTopicAndChannelContext(params: {
  topic: string;
  channelName: string;
  recentMessagesSample: string[];
}): TopicContext {
  const rawTopic = toAsciiDigits(params.topic).trim();
  const normTopic = normMatch(rawTopic);
  const recentJoined = normMatch(params.recentMessagesSample.slice(-6).join(' '));

  let profitText: string | null = null;
  const dollarMatch =
    rawTopic.match(/(\d+(?:\.\d+)?)\s*(?:دولار[اً]?|دولارات|\$|usd)/i) ||
    rawTopic.match(/\$\s*(\d+(?:\.\d+)?)/i);
  const pctMatch = rawTopic.match(/(\d+(?:\.\d+)?)\s*(?:%|بالمئه|بالميه|في الميه)/i);
  const ptsMatch = rawTopic.match(/(\d+(?:\.\d+)?)\s*(?:نقطه|نقطة|نقاط|بيب|pips?)/i);

  if (dollarMatch) {
    profitText = `${dollarMatch[1]} دولار`;
  } else if (pctMatch) {
    profitText = `${pctMatch[1]}%`;
  } else if (ptsMatch) {
    profitText = `${ptsMatch[1]} نقطة`;
  }

  let assetText: string | null = null;
  const combinedForAsset = `${normTopic} ${recentJoined}`;
  if (/(?:الذهب|ذهب|xau|gold)/.test(combinedForAsset)) assetText = 'الذهب';
  else if (/(?:البيتكوين|بيتكوين|btc)/.test(combinedForAsset)) assetText = 'البيتكوين';
  else if (/(?:اليورو|eurusd)/.test(combinedForAsset)) assetText = 'اليورو';
  else if (/(?:الباوند|gbpusd)/.test(combinedForAsset)) assetText = 'الباوند';
  else if (/(?:النفط|oil|wti)/.test(combinedForAsset)) assetText = 'النفط';
  else if (/(?:الناسداك|nasdaq|us100)/.test(combinedForAsset)) assetText = 'الناسداك';
  else if (/(?:الداو|us30)/.test(combinedForAsset)) assetText = 'الداو';
  else if (/(?:سكالبينج|scalping)/.test(normMatch(params.channelName))) assetText = 'السكالبينج';

  const normRaw = normMatch(rawTopic);
  const isLoss = /(?:خساره|خسارة|ستوب|ضرب وقف|انعكاس|تراجع)/.test(normTopic);

  let addressedPerson = 'سليم';
  const addrMatch = rawTopic.match(
    /(?:من|لـ|الى|إلى|عند)\s+(?:القائد|القايد|الكابتن|الاستاذ|الأستاذ|الشيخ)?\s*([^\s،,.?!]+(?:\s+سليم)?)/i
  );
  if (addrMatch) {
    const candidatePerson = addrMatch[1].trim();
    const normCand = normMatch(candidatePerson);
    if (/(?:سليم|salim|ابو سليم)/.test(normCand)) {
      addressedPerson = 'سليم';
    } else if (candidatePerson.length >= 2 && !/^(?:القناه|القناة|الجميع|الكل|التداول)$/.test(normCand)) {
      addressedPerson = candidatePerson;
    }
  } else {
    const directVerbPerson = rawTopic.match(/(?:يس[أا]ل[و]?ا?|يشكر[و]?ا?|يكلم[و]?ا?|تتطلب|تطلب|يطلب[و]?ا?)\s+([^\s،,.?!]+)/i);
    if (directVerbPerson) {
      const normCand = normMatch(directVerbPerson[1]);
      if (/(?:سليم|salim)/.test(normCand)) addressedPerson = 'سليم';
    }
  }

  const hasRequestVerb =
    /(?:يطلب|يطلبو|يطلبوا|تتطلب|تطلب|تطلبو|تطلبوا|نطلب|نحتاج|يرسل|ترسل|ارسل|ارسلو|ينزل|تنزل|نزل|يعطي|تعطي|اعط|عط|شوف لنا|هات|منتظرين|ننتظر|يطالب)/.test(
      normRaw
    );
  const mentionsTradeSignal =
    /(?:صفقات|صفقه|توصيات|توصيه|فرص|فرصه|اشارات|دخول|تحليلات|شغل|تحديث)/.test(normRaw);

  const isRequestTrades = hasRequestVerb && mentionsTradeSignal;
  const isRequestGeneral = !isRequestTrades && hasRequestVerb;

  let requestedPhrase: string | null = null;
  if (hasRequestVerb) {
    const cleanedReq = rawTopic
      .replace(
        /^(?:ان\s+)?(?:الشخصيات\s+|الاعضاء\s+)?(?:يطلب[و]?ا?|تتطلب|تطلب[و]?ا?|نطلب|يطالب[و]?ا?)\s+(?:من\s+(?:القائد\s+|الأستاذ\s+|الكابتن\s+)?[^\s،,.]+\s+)?(?:ان\s+|بـ?\s*)?/i,
        ''
      )
      .replace(/^(?:يرسل[و]?ا?|ترسل|ينزل[و]?ا?|تنزل|يعطي|اعط[و]?ا?)\s+(?:لنا\s+)?/i, '')
      .trim();
    requestedPhrase = cleanedReq.length >= 2 ? cleanedReq : rawTopic;
  }

  const isQuestion =
    !hasRequestVerb &&
    /(?:يسال|يسالو|يسالوا|تسال|تسالو|استفسار|ليش|كيف|متى|وين|ايش|كم)/.test(normRaw);

  let questionPhrase: string | null = null;
  if (isQuestion) {
    const cleanedQ = rawTopic
      .replace(
        /^(?:الشخصيات\s+|الاعضاء\s+)?(?:يس[أا]ل[و]?ا?|تس[أا]ل[و]?ا?|يستفسر[و]?ا?|تستفسر[و]?ا?)\s+(?:(?:من\s+)?(?:القائد\s+|الأستاذ\s+|الكابتن\s+)?[^\s،,.]+\s+)?(?:عن|حول|بخصوص|على)?\s*/i,
        ''
      )
      .trim();
    questionPhrase = cleanedQ.length >= 2 ? cleanedQ : rawTopic;
  }

  const isThanks =
    !hasRequestVerb &&
    !isQuestion &&
    /(?:يشكر|يشكرو|يشكروا|تشكر|تشكرو|شكر|يمدح|يمدحو|تقدير|بارك الله|يعطيك العافيه|ما قصرت)/.test(normRaw);

  const isAnalysis = !isRequestTrades && !isRequestGeneral && /(?:تحليل|توصيه|توصية|نظره|نظرة|سيناريو|تحديث|فرصه|فرصة|دخول)/.test(normTopic) && !profitText;
  const isProfit = !isLoss && !isRequestTrades && !isRequestGeneral && !isQuestion && (Boolean(profitText) || /(?:ربح|اهداف|أهداف|هدف|مكسب|نجاح|ضرب الهدف|حققت)/.test(normTopic));

  const cleanSnippet = rawTopic
    .replace(/^(?:موضوع|صفقه|صفقة|حول|عن)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const topicSnippet = cleanSnippet.length >= 2 ? cleanSnippet.slice(0, 75) : null;

  return {
    profitText,
    assetText,
    isLoss,
    isAnalysis,
    isProfit,
    isRequestTrades,
    isRequestGeneral,
    isQuestion,
    isThanks,
    addressedPerson,
    requestedPhrase,
    questionPhrase,
    channelRef: params.channelName ? params.channelName.trim() : null,
    topicSnippet,
    rawTopicClean: cleanSnippet || rawTopic,
  };
}

interface DialectBank {
  shortExclaims: string[];
  shortTradeRequests: string[];
  openers: string[];
  profitBodies: Array<(ctx: TopicContext) => string>;
  analysisBodies: Array<(ctx: TopicContext) => string>;
  lossBodies: Array<(ctx: TopicContext) => string>;
  requestTradesBodies: Array<(ctx: TopicContext) => string>;
  requestGeneralBodies: Array<(ctx: TopicContext) => string>;
  questionBodies: Array<(ctx: TopicContext) => string>;
  thanksBodies: Array<(ctx: TopicContext) => string>;
  generalBodies: Array<(ctx: TopicContext) => string>;
  replyConnectors: string[];
  requestReplyConnectors: string[];
  closings: string[];
}

const DIALECT_BANKS: Record<string, DialectBank> = {
  صنعاني: {
    shortExclaims: [
      'حيّا الله القائد سليم، شغل نظيف ومرتب',
      'سلمت يمناك يا أبو سليم، الله يفتح عليك',
      'تبارك الرحمن، قراءة رايقة للسوق اليوم',
      'ما شاء الله، دخول مضبوط وفي وقته تماماً',
    ],
    shortTradeRequests: [
      'نحتاج صفقات لو سمحت يا سليم',
      'أرسل لنا صفقات اليوم يا قايد',
      'يا أبو سليم منتظرين صفقاتك الجديدة',
      'بالله يا سليم شوف لنا صفقات حلوة',
    ],
    openers: [
      'حيّاكم الله يا شباب،',
      'والله يا القائد سليم،',
      'الله يبارك في جهدك يا غالي،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `الـ ${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} جت على الصبر والالتزام، والحمد لله على الرزق الطيب`
          : `تحقيق الأهداف${c.assetText ? ` على ${c.assetText}` : ''} بهالشكل يثبت إن الخطة ماشية تمام`,
      (c) =>
        c.assetText
          ? `حركة ${c.assetText} اليوم كانت واضحة للي ركز، و${c.profitText ? `ربح ${c.profitText}` : 'نتيجة الصفقة'} تشرح الخاطر`
          : `صراحة إدارة الصفقة من بدايتها لنهايتها كانت موزونة جداً${c.profitText ? ` و${c.profitText} خير وبركة` : ''}`,
      (c) =>
        c.profitText
          ? `عافية عليك يا سليم، ${c.profitText} صافية وبأعصاب هادية بدون تسرع`
          : `الهدوء وقت الدخول هو سر التوفيق اليوم، ما قصرت يا قايد`,
    ],
    analysisBodies: [
      (c) =>
        `القراءة${c.assetText ? ` لحركة ${c.assetText}` : ''} منطقية جداً، خلونا نتابع الإغلاق ونلتزم بالخطة`,
      () => `تحليل رايق وواضح، أهم شي ما نستعجل ونمشي مع المستويات خطوة بخطوة`,
    ],
    lossBodies: [
      () => `السوق أخذ وعطا، وأهم شي إن الخسارة محسوبة والالتزام بالستوب حمى الحساب`,
      () => `عادي جداً يا شباب، القائد علّمنا نلتزم بالإدارة والجايات تعوّض أضعاف بإذن الله`,
    ],
    requestTradesBodies: [
      (c) => `يا قايد ${c.addressedPerson}، بالله أرسل لنا صفقات اليوم، كلنا متابعين القناة ومنتظرين إشارتك`,
      (c) => `نحتاج صفقات لو سمحت يا ${c.addressedPerson}، السوق يتحرك اليوم وحابين ندخل معك على رواقة`,
      (c) => `حيّا الله ${c.addressedPerson}، ما بش صفقات جديدة الآن؟ ودّنا نشتغل معك في السوق`,
      (c) => `يا أبو سليم الله يحفظك، إذا شفت فرصة مضبوطة أرسلنا صفقات خلنا نستفيد منها`,
      (c) => `صراحة متحمسين للشغل اليوم يا ${c.addressedPerson}، نحتاج منك صفقات مرتبة كعادتك`,
    ],
    requestGeneralBodies: [
      (c) => `يا ${c.addressedPerson} لو سمحت، ممكن ${c.requestedPhrase || c.rawTopicClean} اليوم الله يحفظك`,
      (c) => `بالله يا قايد ${c.addressedPerson} لا تقصر معنا، ودّنا ${c.requestedPhrase || c.rawTopicClean}، كلنا منتظرينك`,
      (c) => `حيّاك الله يا ${c.addressedPerson}، يا ريت تقدر ${c.requestedPhrase || c.rawTopicClean} لا هنت`,
    ],
    questionBodies: [
      (c) => `يا ${c.addressedPerson} لو سمحت حابين نستفسر منك عن ${c.questionPhrase || c.rawTopicClean}؟`,
      (c) => `يا قايد ${c.addressedPerson}، إيش الوضع بخصوص ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `الله يبيض وجهك يا ${c.addressedPerson}، ما قصرت والله ومجهودك واضح للجميع`,
      (c) => `تسلم يمناك يا قايد ${c.addressedPerson}، ربنا يبارك لك في وقتك وجهدك معنا`,
    ],
    generalBodies: [
      (c) => `صراحة موضوع «${c.rawTopicClean}» يستاهل التركيز يا شباب، والواحد يلاحظ فرقه لما يطبّقه صح`,
      (c) => `والله كلام في الصميم حول ${c.rawTopicClean}، أهم شي الصبر والالتزام وما نستعجل`,
      (c) => `من ناحيتي جربت فكرة ${c.rawTopicClean} هالأيام وفعلاً فرقت معي في هدوء القرار`,
      (c) => `إيش رأيكم يا إخوان في موضوع ${c.rawTopicClean}؟ أحسه من أهم النقاط اللي لازم ننتبه لها`,
    ],
    replyConnectors: [
      'فعلاً كلامك مضبوط،',
      'وأنا لاحظت نفس النقطة وقت الدخول،',
      'صدقت والله،',
      'معك حق مية بالمية،',
    ],
    requestReplyConnectors: [
      'وأنا معك والله،',
      'نفس الطلب يا قايد،',
      'أيوه بالله، كلنا منتظرين،',
      'فعلاً يا ريت،',
    ],
    closings: [
      'ربنا يبارك للجميع.',
      'بالتوفيق في الصفقات الجاية.',
      'الله يزيدك من فضله.',
      '',
      '🤲',
    ],
  },
  عدني: {
    shortExclaims: [
      'يا سلام عليك يا سليم، شغل فنان والله',
      'تمام التمام، صفقة رايقة وتستاهل',
      'تسلم يا كابتن، دايماً عند حسن الظن',
      'شغل عالي ومرتب، يعطيك العافية',
    ],
    shortTradeRequests: [
      'أرسلنا صفقات اليوم يا سليم',
      'نحتاج صفقات لو سمحت يا كابتن',
      'شوف لنا صفقات جديدة يا سليم',
      'منتظرين صفقاتك اليوم يا غالي',
    ],
    openers: [
      'يا سلام والله،',
      'تسلم يا سليم،',
      'شوفوا يا جماعة،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `${c.profitText}${c.assetText ? ` من ${c.assetText}` : ''} نتيجة تفتح النفس، والالتزام بالمستويات فرق كثير`
          : `الهدف انضرب بسلاسة${c.assetText ? ` في ${c.assetText}` : ''} وما في أحلى من الصفقة النظيفة`,
      (c) =>
        c.profitText
          ? `دخلنا على هدوء وطلعنا بـ ${c.profitText}، يعني شغل محسوب من الآخر`
          : `والله متابعة ممتازة وتوقيت الخروج كان بالملّي، ما قصرت يا كابتن`,
      (c) =>
        `الحلو في الموضوع إن كل خطوة واضحة وما فيها عشوائية${c.profitText ? `، مبروك الـ ${c.profitText}` : ''}`,
    ],
    analysisBodies: [
      (c) => `نظرة قوية${c.assetText ? ` على ${c.assetText}` : ''}، بنراقب الحركة معك أول بأول`,
      () => `كلام سليم وواضح، ننتظر تأكيد الإشارات قبل أي حركة`,
    ],
    lossBodies: [
      () => `معوضين خير إن شاء الله، السوق فرص ومثل ما نربح لازم نتقبل الستوب بروح رياضية`,
      () => `الحمد لله إن الإدارة سليمة، نرتاح شوي ونركز على الفرصة الجاية`,
    ],
    requestTradesBodies: [
      (c) => `يا كابتن ${c.addressedPerson} لو سمحت أرسل لنا صفقات اليوم، السوق فيه حركة حلوة وما نبي نفوّتها`,
      (c) => `نحتاج صفقات يا ${c.addressedPerson}، بالله نزّل لنا شي حلو ندخل فيه اليوم`,
      (c) => `يا ${c.addressedPerson} أرسلنا صفقات جديدة لو تقدر، كلنا جاهزين ومتابعين القناة`,
      (c) => `تسلم يا ${c.addressedPerson}، بس بالله عطنا صفقات اليوم خلنا نسترزق معك`,
      (c) => `شوف لنا صفقات رايقة اليوم يا كابتن ${c.addressedPerson}، منتظرين إشارتك بفارغ الصبر`,
    ],
    requestGeneralBodies: [
      (c) => `يا كابتن ${c.addressedPerson} لو تكرمت ممكن ${c.requestedPhrase || c.rawTopicClean} اليوم`,
      (c) => `لو تقدر يا ${c.addressedPerson} تخلّص لنا موضوع ${c.requestedPhrase || c.rawTopicClean}، كلنا ننتظرك`,
      (c) => `يا ${c.addressedPerson} بالله لا تتأخر علينا، نبيك ${c.requestedPhrase || c.rawTopicClean} يعطيك العافية`,
    ],
    questionBodies: [
      (c) => `يا كابتن ${c.addressedPerson} ممكن توضح لنا ${c.questionPhrase || c.rawTopicClean}؟`,
      (c) => `لو سمحت يا ${c.addressedPerson}، إيش رأيك في ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `يا سلام عليك يا ${c.addressedPerson}، والله ما قصرت أبد ويعطيك ألف عافية`,
      (c) => `تسلم والله يا كابتن ${c.addressedPerson}، متابعتك وتعبك معنا محل تقدير كبير`,
    ],
    generalBodies: [
      (c) => `يا جماعة موضوع ${c.rawTopicClean} مهم مرة، واللي يركز عليه يرتاح على المدى الطويل`,
      (c) => `والله نقاش حلو بخصوص ${c.rawTopicClean}، كل واحد يشاركنا تجربته عشان نستفيد`,
      (c) => `شوفوا الصراحة في ${c.rawTopicClean}، الانضباط والاستمرارية أهم من أي حماس لحظي`,
      (c) => `تمام التمام، طرح موضوع ${c.rawTopicClean} جاء في وقته ومفيد للكل`,
    ],
    replyConnectors: [
      'والله إنك جبتها صح،',
      'نفس الكلام اللي كنت بقوله،',
      'أكيد، والتركيز هو الأساس،',
      'تمام عليك،',
    ],
    requestReplyConnectors: [
      'والله نفس اللي في بالي،',
      'أيوه بالله يا كابتن،',
      'تمام الكلام، كلنا منتظرين،',
      'معك والله،',
    ],
    closings: [
      'ربنا يوفقنا جميعاً.',
      'مستمرين معكم بالخير.',
      'موفقين يا رب.',
      '',
      '📈',
    ],
  },
  تعزي: {
    shortExclaims: [
      'كفو والله يا سليم، بيّض الله وجهك',
      'خطوة قوية ومرتبة، بارك الله فيك',
      'الله يزيدك من فضله يا قائدنا',
      'شغل متعوب عليه، عاشت الأيادي',
    ],
    shortTradeRequests: [
      'نحتاج صفقات لو سمحت يا قائدنا',
      'أرسل لنا صفقات يا سليم لا هنت',
      'منتظرين صفقاتك الحلوة يا أبو سليم',
      'نزّل لنا صفقات اليوم بارك الله فيك',
    ],
    openers: [
      'والله كفو يا سليم،',
      'أحسنت يا بطل،',
      'حقيقة يا إخوان،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `تحقيق ${c.profitText}${c.assetText ? ` على ${c.assetText}` : ''} يبرهن إن الصبر مع التحليل الدقيق ما يضيع`
          : `الالتزام بالأهداف جاب نتيجة ترفع الرأس${c.assetText ? ` في ${c.assetText}` : ''}`,
      (c) =>
        c.assetText
          ? `تابعنا ${c.assetText} خطوة بخطوة مع القائد والنتيجة${c.profitText ? ` (${c.profitText})` : ''} كانت مستحقة بجدارة`
          : `تنظيم ممتاز للصفقة من نقطة الدخول لين حجز الربح${c.profitText ? ` بـ ${c.profitText}` : ''}`,
      (c) =>
        c.profitText
          ? `ربح ${c.profitText} خطوة طيبة في مسار التحدي، والأهم الاستمرار بنفس الانضباط`
          : `انضباط ممتاز وثبات على الخطة من البداية للنهاية`,
    ],
    analysisBodies: [
      (c) => `توجيه ممتاز${c.assetText ? ` في ${c.assetText}` : ''}، والوضوح في الشرح يريح المتابعين`,
      () => `رؤية موفقة ومقنعة، ننتظر تفاعل السعر عند المناطق المحددة`,
    ],
    lossBodies: [
      () => `ما عليه يا قائد، الانضباط في وقف الخسارة هو اللي يحافظ على رأس المال للفرص الأقوى`,
      () => `التزامنا بالخطة أهم من صفقة واحدة، وربنا يعوّضنا بالأحسن`,
    ],
    requestTradesBodies: [
      (c) => `يا قائدنا ${c.addressedPerson}، نحتاج صفقات لو سمحت، عسى الله يرزقنا وإياكم الخير`,
      (c) => `أرسل لنا صفقات يا ${c.addressedPerson} بارك الله فيك، جاهزين ومتابعين معك أول بأول`,
      (c) => `لو تتكرم يا أبو ${c.addressedPerson} تنزّل لنا صفقات اليوم، كلنا منتظرين توجيهك`,
      (c) => `كفو يا ${c.addressedPerson}، نبي منك صفقات حلوة اليوم نمشي فيها على خطتك المعتادة`,
    ],
    requestGeneralBodies: [
      (c) => `يا قائدنا ${c.addressedPerson}، نتمنى منك ${c.requestedPhrase || c.rawTopicClean} في أقرب وقت`,
      (c) => `بارك الله فيك يا ${c.addressedPerson}، ممكن ${c.requestedPhrase || c.rawTopicClean} لو سمحت`,
      (c) => `يا ${c.addressedPerson} لو تتكرم علينا و${c.requestedPhrase || c.rawTopicClean} نكون شاكرين لك`,
    ],
    questionBodies: [
      (c) => `يا قائدنا ${c.addressedPerson}، عندنا سؤال بخصوص ${c.questionPhrase || c.rawTopicClean} لو تكرمت؟`,
      (c) => `نستأذنك يا ${c.addressedPerson}، ممكن توضح لنا ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `كفو والله يا ${c.addressedPerson}، بيّض الله وجهك على كل ما تقدمه للأعضاء`,
      (c) => `شكراً جزيلاً يا قائد ${c.addressedPerson}، تعبك معنا واضح ومثمور بإذن الله`,
    ],
    generalBodies: [
      (c) => `حقيقة موضوع ${c.rawTopicClean} يحتاج وقفة جادة من الجميع لأن أثره يبان مع الوقت`,
      (c) => `أعجبني فتح النقاش حول ${c.rawTopicClean}، الوضوح في هذه النقطة يختصر علينا أخطاء كثيرة`,
      (c) => `عن تجربة، الالتزام بـ ${c.rawTopicClean} يعطي ثقة كبيرة ويخلي خطواتنا ثابتة`,
      (c) => `ممتاز يا شباب، تبادل الآراء حول ${c.rawTopicClean} يثري القناة ويفيد المبتدئ والمحترف`,
    ],
    replyConnectors: [
      'نعم بالضبط،',
      'وأزيد على كلامك إن',
      'فعلاً نقطة مهمة جداً،',
      'أتفق معك تماماً،',
    ],
    requestReplyConnectors: [
      'أؤيدك تماماً،',
      'فعلاً يا قائدنا نحتاج هذا،',
      'ونحن ننتظر معك،',
      'نفس الطلب والله،',
    ],
    closings: [
      'دمت متألقاً يا سليم.',
      'ربي يبارك لنا ولكم.',
      'إلى الأمام دائماً.',
      '',
      '✨',
    ],
  },
  حضرمي: {
    shortExclaims: [
      'بارك الله فيك يا أبو سليم، خير وبركة',
      'طرح طيب ومبارك، ما قصرت يا غالي',
      'الله يرزقنا وإياكم الرزق الحلال الطيب',
      'نتيجة طيبة وتستاهل كل خير',
    ],
    shortTradeRequests: [
      'نحتاج صفقات طيبة يا أبو سليم',
      'أرسل لنا صفقات اليوم بارك الله فيك',
      'لو في صفقات جاهزة شاركها معنا يا غالي',
      'بانتظار صفقاتك المباركة يا سليم',
    ],
    openers: [
      'الله يبارك فيك يا أبو سليم،',
      'الحمد لله أولاً وآخراً،',
      'يا أخي الفاضل،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} رزق مبارك بالهدوء وعدم الطمع، نسأل الله البركة للجميع`
          : `خروج موفق وحصيلة طيبة${c.assetText ? ` على ${c.assetText}` : ''} تدل على حسن التدبير`,
      (c) =>
        c.profitText
          ? `البركة في القليل المنضبط، و${c.profitText} اليوم حصاد تعب وتركيز واضح`
          : `ما شاء الله، التدرج والثبات بدون استعجال هو اللي صنع الفرق اليوم`,
      () => `حفظك الله يا سليم، قراءة متزنة وتوجيه سديد يطمن الواحد وهو يتابع`,
    ],
    analysisBodies: [
      (c) => `توجيه سديد${c.assetText ? ` حول ${c.assetText}` : ''}، نسأل الله التوفيق والسداد`,
      () => `تحليل هادئ ومتوازن كعادتك، وبإذن الله تتضح الحركة قريباً`,
    ],
    lossBodies: [
      () => `الحمد لله على كل حال، الخسارة القليلة المحسوبة درس ووقاية من الخسارة الكبيرة`,
      () => `لا بأس يا أبو سليم، السوق أيام والرزق مكتوب، المهم السلامة والالتزام`,
    ],
    requestTradesBodies: [
      (c) => `يا أبو ${c.addressedPerson} بارك الله فيك، إذا توفرت صفقات اليوم أرسلها لنا لا هنت`,
      (c) => `نحتاج صفقات طيبة يا ${c.addressedPerson}، نسأل الله يفتح علينا وعليكم من واسع فضله`,
      (c) => `أرسل لنا صفقات اليوم يا غالي، متابعين القناة ومنتظرين طرحك المبارك يا ${c.addressedPerson}`,
      (c) => `الله يرزقنا وإياكم الخير، لو في صفقات جاهزة يا ${c.addressedPerson} شاركها معنا الله يحفظك`,
    ],
    requestGeneralBodies: [
      (c) => `بارك الله فيك يا أبو ${c.addressedPerson}، نأمل منك ${c.requestedPhrase || c.rawTopicClean} متى تيسّر لك`,
      (c) => `يا أخي ${c.addressedPerson}، يا ريت ${c.requestedPhrase || c.rawTopicClean} لو سمحت، جزاك الله خيراً`,
      (c) => `نسأل الله التوفيق، لو تتكرم يا ${c.addressedPerson} و${c.requestedPhrase || c.rawTopicClean} للجميع`,
    ],
    questionBodies: [
      (c) => `بارك الله فيك يا ${c.addressedPerson}، حبيت أسأل عن ${c.questionPhrase || c.rawTopicClean}؟`,
      (c) => `يا أبو ${c.addressedPerson} لو تكرّمت تفيدنا بخصوص ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `بارك الله فيك يا أبو ${c.addressedPerson}، جزاك الله خيراً على ما تبذله لنا`,
      (c) => `أكرمك الله يا ${c.addressedPerson}، نسأل الله أن يبارك لك في رزقك وعملك`,
    ],
    generalBodies: [
      (c) => `طرح مبارك حول ${c.rawTopicClean}، نسأل الله التوفيق والفائدة للجميع`,
      (c) => `الحديث في ${c.rawTopicClean} نافع جداً، لأن التدرج والهدوء هم أساس النجاح`,
      (c) => `بارك الله فيكم، موضوع ${c.rawTopicClean} يذكّرنا دايماً بأهمية التأني وعدم التسرع`,
      (c) => `من واقع المتابعة، الاهتمام بـ ${c.rawTopicClean} يصنع فرقاً طيباً مع الأيام`,
    ],
    replyConnectors: [
      'بارك الله فيك على هذه الملاحظة،',
      'صدقت يا أخي،',
      'وهذا اللي لمسناه فعلاً،',
      'كلام موزون،',
    ],
    requestReplyConnectors: [
      'بارك الله فيك، ونحن نضم صوتنا لك —',
      'صدقت يا أخي، كلنا ننتظر —',
      'نعم والله —',
      'ويا ريت والله —',
    ],
    closings: [
      'الله يرزق الجميع من واسع فضله.',
      'بارك الله لكم في أوقاتكم.',
      'في حفظ الله.',
      '',
    ],
  },
  إبّي: {
    shortExclaims: [
      'روعة يا سليم، ما شاء الله تبارك الله',
      'أبدعت والله، صفقة في المليان',
      'يا عيني على التوقيت، تسلم يا قايد',
      'مبارك يا شباب، خطوة حلوة ومرتبة',
    ],
    shortTradeRequests: [
      'أرسلنا صفقات يا سليم بالله',
      'نحتاج صفقات لو سمحت يا قايد',
      'متشوقين لصفقاتك اليوم يا سليم',
      'نزّل لنا صفقات جديدة يا بطل',
    ],
    openers: [
      'يا عيني عليك يا سليم،',
      'والله بصراحة،',
      'ما شاء الله يا قايد،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `جبنا الـ ${c.profitText}${c.assetText ? ` من ${c.assetText}` : ''} بكل أريحية، هذا التداول اللي يرفع المعنويات`
          : `دخول ذكي وحصاد سريع للأهداف${c.assetText ? ` في ${c.assetText}` : ''}، عقبال القادم أقوى`,
      (c) =>
        c.assetText
          ? `تفاعل ${c.assetText} مشى بالضبط زي ما توقعت، والربح${c.profitText ? ` (${c.profitText})` : ''} جا في محله`
          : `أهم حاجة الالتزام بنقطة الخروج بدون تردد، وشغلك يا سليم يبرد القلب`,
    ],
    analysisBodies: [
      (c) => `متحمسين نشوف حركة ${c.assetText || 'السوق'} الجاية مع تحليلك الرايق`,
      () => `خطة مرتبة وسهلة الفهم للجميع، يعطيك ألف عافية`,
    ],
    lossBodies: [
      () => `المهم الالتزام، وصفقة وحدة ما تغيّر المسار العام للتحدي بإذن الله`,
      () => `ربنا يعوّضها بأحسن منها، التجربة والانضباط هم المكسب الحقيقي`,
    ],
    requestTradesBodies: [
      (c) => `يا قايد ${c.addressedPerson}، بالله أرسلنا صفقات اليوم، الأعضاء كلهم منتظرينك في القناة`,
      (c) => `نحتاج صفقات لو سمحت يا ${c.addressedPerson}، شغلك دايماً يبرد القلب ومضمون`,
      (c) => `${c.addressedPerson} يا بطل، نزّل لنا صفقات جديدة خلنا نبدأ التداول بحماس`,
      (c) => `والله متشوقين لصفقاتك يا قايد ${c.addressedPerson}، لا تطوّل علينا بالله`,
    ],
    requestGeneralBodies: [
      (c) => `يا قايد ${c.addressedPerson} بالله نبيك ${c.requestedPhrase || c.rawTopicClean} اليوم لو تكرمت`,
      (c) => `لو تقدر يا ${c.addressedPerson} تساعدنا في ${c.requestedPhrase || c.rawTopicClean}، كلنا متحمسين`,
      (c) => `يا ${c.addressedPerson} ما نستغني عنك، لا هنت لو ${c.requestedPhrase || c.rawTopicClean}`,
    ],
    questionBodies: [
      (c) => `يا قايد ${c.addressedPerson} بالله نسألك عن ${c.questionPhrase || c.rawTopicClean}، إيش الوضع؟`,
      (c) => `ممكن توضّح لنا يا ${c.addressedPerson} بخصوص ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `تسلم يا قايد ${c.addressedPerson}، والله شغلك يبرد القلب وما قصرت معنا`,
      (c) => `يعطيك العافية يا ${c.addressedPerson}، منورين بوجودك ومجهودك الرائع`,
    ],
    generalBodies: [
      (c) => `والله إن موضوع ${c.rawTopicClean} يمس كل واحد فينا، وكلامكم عنه يحفّز بجد`,
      (c) => `أحلى ما في القناة إننا نناقش أمور عملية مثل ${c.rawTopicClean} بروح أخوية`,
      (c) => `بصراحة فكرة ${c.rawTopicClean} لو مشينا عليها صح بنشوف نتيجة طيبة بإذن الله`,
      (c) => `منورين يا شباب، شاركونا وجهة نظركم في ${c.rawTopicClean} خلونا نتعلم من بعض`,
    ],
    replyConnectors: [
      'أشهد بالله،',
      'فعلاً يا جماعة،',
      'كلامك سليم وأنا معك،',
      'بلا شك،',
    ],
    requestReplyConnectors: [
      'أشهد بالله كلنا منتظرين،',
      'أيوه والله يا قايد،',
      'وأنا بعد أقول نفس الشي،',
      'بجد نحتاجها اليوم،',
    ],
    closings: [
      'الله يسعدكم جميعاً.',
      'بانتظار القادم يا قايد.',
      'بالتوفيق للكل.',
      '',
    ],
  },
  يافعي: {
    shortExclaims: [
      'كفو يا ذيب، قراءة ما تخرش الميه',
      'حيّاك الله يا سليم، شغل رجال ومرتب',
      'مبروك الربح، خطوة ثابتة للأمام',
      'الله يوفقك ويزيدك تألق يا قائد',
    ],
    shortTradeRequests: [
      'أرسل لنا صفقات اليوم يا ذيب',
      'نحتاج صفقات جديدة يا أبو سليم',
      'لا تنسانا من صفقاتك اليوم يا قايد',
      'كلنا جاهزين للصفقات يا سليم',
    ],
    openers: [
      'حيّا الله القائد،',
      'بصراحة يا سليم،',
      'والله شغلك يبيض الوجه،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} حلال زلال، وثمرة المتابعة الدقيقة والهدوء`
          : `نجاح واضح في قنص الحركة${c.assetText ? ` على ${c.assetText}` : ''} بدون أي تخبط`,
      (c) =>
        c.profitText
          ? `تحدي سليم يثبت يوم بعد يوم إنه ماشي بثبات، و${c.profitText} خطوة ممتازة`
          : `الدخول المحسوب يريح البال ويحقق الهدف بهدوء، تسلم يا غالي`,
    ],
    analysisBodies: [
      (c) => `متابعين معك في ${c.assetText || 'الصفقات'} أول بأول، قراءة تبعث على الثقة`,
      () => `نقاط واضحة وما فيها لبس، الله يوفقنا للخير`,
    ],
    lossBodies: [
      () => `البطل هو اللي يحفظ حسابه وقت الانعكاس، وما قصرت بالالتزام بالوقف`,
      () => `كل متداول يمر بوقف خسارة، والعبرة بالنتيجة النهائية في نهاية الأسبوع`,
    ],
    requestTradesBodies: [
      (c) => `يا ذيب ${c.addressedPerson}، أرسل لنا صفقات اليوم، كلنا متابعين ومستعدين للدخول`,
      (c) => `لو سمحت يا أبو ${c.addressedPerson} نحتاج صفقات جديدة اليوم، الله يوفقك ويبارك فيك`,
      (c) => `حيّاك الله يا قايد ${c.addressedPerson}، لا تنسانا من صفقاتك المضبوطة اليوم`,
      (c) => `أرسلنا صفقات يا غالي، السوق ماشي ونبي ندخل معك بثبات يا ${c.addressedPerson}`,
    ],
    requestGeneralBodies: [
      (c) => `حيّاك الله يا ${c.addressedPerson}، نطلب منك ${c.requestedPhrase || c.rawTopicClean} اليوم لا هنت`,
      (c) => `يا قايد ${c.addressedPerson}، كلنا منتظرين منك ${c.requestedPhrase || c.rawTopicClean} لو سمحت`,
      (c) => `لا تقصر معنا يا ذيب ${c.addressedPerson} و${c.requestedPhrase || c.rawTopicClean}`,
    ],
    questionBodies: [
      (c) => `حيّاك الله يا ${c.addressedPerson}، ودّنا نسألك عن ${c.questionPhrase || c.rawTopicClean}؟`,
      (c) => `يا قايد ${c.addressedPerson}، ما توجيهك بخصوص ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `بيّض الله وجهك يا ${c.addressedPerson}، وقفتك معنا وتوجيهاتك ترفع الرأس`,
      (c) => `تسلم يا ذيب ${c.addressedPerson}، دايماً عند حسن الظن وما تقصر`,
    ],
    generalBodies: [
      (c) => `والله موضوع ${c.rawTopicClean} في محله تماماً، ويستحق كل واحد يركز عليه`,
      (c) => `حيّاكم الله يا شباب، اللي يلتزم في ${c.rawTopicClean} يمشي بخطى واثقة وما يتشتت`,
      (c) => `صحيح مية بالمية، تجربة ${c.rawTopicClean} تثبت إن التنظيم هو سر الاستمرار`,
      (c) => `يعجبني النقاش الهادف حول ${c.rawTopicClean}، كلنا نطلع منه بفائدة حقيقية`,
    ],
    replyConnectors: [
      'كلامك ذهب،',
      'بالضبط زي ما تفضلت،',
      'ونعم بالله،',
      'هذا الكلام الصح،',
    ],
    requestReplyConnectors: [
      'ونعم والله، كلنا نطلب نفس الشي —',
      'بالضبط يا غالي،',
      'مستعدين ومنتظرين —',
      'وأنا معكم في الطلب،',
    ],
    closings: [
      'موفق دايماً يا أبو سليم.',
      'عقبال الأهداف الأكبر.',
      'دمتم بخير.',
      '',
    ],
  },
  'فصحى يمنية': {
    shortExclaims: [
      'أداء منضبط ومميز يا قائد سليم',
      'نتيجة موفقة، نسأل الله لكم دوام التوفيق',
      'قراءة دقيقة وإدارة حكيمة للصفقة',
      'مبارك عليكم هذا الإنجاز الطيب',
    ],
    shortTradeRequests: [
      'نحتاج صفقات لو تكرمت يا قائد سليم',
      'نرجو إرسال صفقات اليوم إذا سمحت',
      'بانتظار صفقاتك القادمة يا سليم',
      'شاركنا صفقات اليوم وفقك الله',
    ],
    openers: [
      'تقديرنا لجهودك يا قائد سليم،',
      'في الحقيقة،',
      'ما شاء الله،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `تحقيق ${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} يعكس التزاماً حقيقياً بإدارة المخاطر والانتظار للتوقيت المناسب`
          : `الوصول للأهداف المرسومة${c.assetText ? ` على ${c.assetText}` : ''} يؤكد قوة التحليل وثبات الخطة`,
      (c) =>
        `الهدوء والانضباط عند تنفيذ الصفقة هما مفتاح الاستمرارية${c.profitText ? `، وربح ${c.profitText} ثمرة طيبة` : ''}`,
    ],
    analysisBodies: [
      (c) => `قراءة متزنة${c.assetText ? ` لحركة ${c.assetText}` : ''}، ونسأل الله التوفيق في القادم`,
      () => `شرح وافٍ يضع النقاط على الحروف، نتابع معك التحديثات`,
    ],
    lossBodies: [
      () => `الالتزام بوقف الخسارة جزء أصيل من النجاح، والعبرة بإجمالي الأداء على المدى القريب`,
      () => `نتعامل مع وقف الخسارة بهدوء، والفرص المتجددة في السوق تعوّض بإذن الله`,
    ],
    requestTradesBodies: [
      (c) => `يا قائد ${c.addressedPerson}، نرجو منك إرسال صفقات اليوم إذا توفرت الفرص المناسبة`,
      (c) => `نحتاج صفقات جديدة لو تكرمت يا ${c.addressedPerson}، فنحن نتابع تحديثاتك باستمرار`,
      (c) => `لو سمحت يا قائدنا ${c.addressedPerson}، شاركنا صفقات اليوم لنستفيد من تحليلك وخبرتك`,
      (c) => `متواجدون في القناة وبانتظار إرسالك للصفقات الجديدة يا ${c.addressedPerson}، وفقك الله`,
    ],
    requestGeneralBodies: [
      (c) => `يا قائد ${c.addressedPerson}، نرجو منك أن ${c.requestedPhrase || c.rawTopicClean} متى أمكن ذلك`,
      (c) => `نتطلع جميعاً يا ${c.addressedPerson} إلى أن ${c.requestedPhrase || c.rawTopicClean}، شاكرين لك اهتمامك`,
      (c) => `لو سمحت يا ${c.addressedPerson}، نحتاج في القناة أن ${c.requestedPhrase || c.rawTopicClean}`,
    ],
    questionBodies: [
      (c) => `يا قائد ${c.addressedPerson}، نرجو إفادتنا بخصوص ${c.questionPhrase || c.rawTopicClean}؟`,
      (c) => `سؤال لو تكرمت يا ${c.addressedPerson}: ما رأيك في ${c.questionPhrase || c.rawTopicClean}؟`,
    ],
    thanksBodies: [
      (c) => `شكراً جزيلاً يا قائد ${c.addressedPerson} على جهودك المستمرة وحرصك على إفادة الجميع`,
      (c) => `نقدّر عطاءك المميز يا ${c.addressedPerson}، جزاك الله خيراً وبارك في مسعاك`,
    ],
    generalBodies: [
      (c) => `موضوع «${c.rawTopicClean}» يمثل ركيزة مهمة لأي متداول يسعى للاستقرار والاستمرارية`,
      (c) => `النقاش الواعي حول ${c.rawTopicClean} يساعدنا على تفادي الأخطاء الشائعة وبناء رؤية واضحة`,
      (c) => `نتفق جميعاً أن تطبيق ${c.rawTopicClean} بانضباط هو الفارق الحقيقي في النتائج`,
      (c) => `شكراً لإثارة موضوع ${c.rawTopicClean}، نتطلع لسماع تجارب الأعضاء وآرائهم هنا`,
    ],
    replyConnectors: [
      'أوافقك الرأي تماماً،',
      'إضافة قيّمة، وفعلاً',
      'صدقت، فالالتزام',
      'كما ذكرت تماماً،',
    ],
    requestReplyConnectors: [
      'نؤيد هذا الطلب جميعاً،',
      'ونحن كذلك ننتظر معك،',
      'فعلاً يا قائدنا نرجو ذلك،',
      'نضم صوتنا لكم،',
    ],
    closings: [
      'نسأل الله البركة والتوفيق للجميع.',
      'واصل هذا العطاء المميز.',
      '',
    ],
  },
};

function selectDiversePersonas(
  count: number,
  realNamesNormSet: Set<string>
): Array<{ name: string; dialect: string; gender: 'm' | 'f' }> {
  const shuffled = shuffleArr(YEMENI_PERSONA_POOL);
  const picked: Array<{ name: string; dialect: string; gender: 'm' | 'f' }> = [];
  const usedNorm = new Set<string>(realNamesNormSet);

  for (const cand of shuffled) {
    if (picked.length >= count) break;
    const n = normMatch(cand.name);
    if (!usedNorm.has(n)) {
      usedNorm.add(n);
      picked.push(cand);
    }
  }

  let idx = 0;
  while (picked.length < count) {
    const base = YEMENI_PERSONA_POOL[idx % YEMENI_PERSONA_POOL.length];
    const suf = FALLBACK_SURNAMES[(idx + 3) % FALLBACK_SURNAMES.length];
    let candidateName = `${base.name.split(' ')[0]} ${suf}`;
    if (usedNorm.has(normMatch(candidateName))) {
      candidateName = `${base.name.split(' ')[0]} ${suf} ${picked.length + 1}`;
    }
    usedNorm.add(normMatch(candidateName));
    picked.push({ name: candidateName, dialect: base.dialect, gender: base.gender });
    idx++;
  }

  return picked;
}

export function generateInternalYemeniPersonas(params: {
  topic: string;
  count: number;
  channelName: string;
  recentMessagesSample: string[];
  realNamesNormSet: Set<string>;
  fixedPersonas?: Array<{ name: string; dialect?: string }>;
}): InternalPersonaDraftItem[] {
  const dialectKeys = Object.keys(DIALECT_BANKS);
  const fixedList = Array.isArray(params.fixedPersonas) && params.fixedPersonas.length > 0
    ? params.fixedPersonas
    : null;
  const safeCount = fixedList
    ? fixedList.length
    : Math.max(1, Math.min(30, Math.floor(Number(params.count) || 3)));
  const ctx = analyzeTopicAndChannelContext(params);
  const baseDialectOffset = crypto.randomInt(0, dialectKeys.length);
  const personas = fixedList
    ? fixedList.map((fp, idx) => ({
        name: String(fp.name || `عضو ${idx + 1}`).trim(),
        dialect:
          fp.dialect && DIALECT_BANKS[fp.dialect]
            ? fp.dialect
            : dialectKeys[(baseDialectOffset + idx) % dialectKeys.length],
        gender: 'm' as const,
      }))
    : selectDiversePersonas(safeCount, params.realNamesNormSet);

  const usedTexts = new Set<string>(params.recentMessagesSample.map((t) => normMatch(t)));
  const usedOpeners = new Set<string>();
  const usedBodies = new Set<string>();
  const usedClosings = new Set<string>();

  const styleModes = ['قصير وعفوي', 'متوسط متفاعل', 'رد حواري متصل', 'تحليلي هادئ', 'تشجيعي مختصر'];
  const items: InternalPersonaDraftItem[] = [];

  const selectBodyPool = (bank: DialectBank): Array<(ctx: TopicContext) => string> => {
    if (ctx.isRequestTrades) return bank.requestTradesBodies;
    if (ctx.isRequestGeneral) return bank.requestGeneralBodies;
    if (ctx.isQuestion) return bank.questionBodies;
    if (ctx.isThanks) return bank.thanksBodies;
    if (ctx.isLoss) return bank.lossBodies;
    if (ctx.isAnalysis) return bank.analysisBodies;
    if (ctx.isProfit) return bank.profitBodies;
    return bank.generalBodies;
  };

  const isDirectiveSpeechAct = ctx.isRequestTrades || ctx.isRequestGeneral || ctx.isQuestion || ctx.isThanks;

  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    const bank = DIALECT_BANKS[persona.dialect] || DIALECT_BANKS['صنعاني'];

    const useShort = isDirectiveSpeechAct
      ? (ctx.isRequestTrades && (i % 4 === 2))
      : !ctx.isProfit && !ctx.isLoss && !ctx.isAnalysis
      ? i % 5 === 4
      : (i === 0 ? crypto.randomInt(0, 3) === 0 : i % 4 === 2);
    const useReplyConnector = safeCount >= 2 && i > 0 && (i === 1 || i % 3 === 1);
    let text = '';
    let styleTag = styleModes[i % styleModes.length];

    for (let attempt = 0; attempt < 28; attempt++) {
      let candidate = '';
      if (useShort && attempt < 6) {
        const shortPool = ctx.isRequestTrades ? bank.shortTradeRequests : bank.shortExclaims;
        const ex = pickRandom(shortPool);
        if (!usedBodies.has(normMatch(ex))) {
          candidate = ex;
          styleTag = 'قصير وعفوي';
        }
      }

      if (!candidate) {
        const bodyPool = selectBodyPool(bank);
        const rawBodyFn = bodyPool[(i + attempt) % bodyPool.length];
        const body = rawBodyFn(ctx);
        const normBody = normMatch(body);
        if (usedBodies.has(normBody) && attempt < 18) continue;

        let prefix = '';
        if (useReplyConnector && attempt < 18) {
          const connBank = ctx.isRequestTrades || ctx.isRequestGeneral ? bank.requestReplyConnectors : bank.replyConnectors;
          const connCandidates = connBank.filter((c) => !usedOpeners.has(normMatch(c)));
          prefix = connCandidates.length > 0 ? pickRandom(connCandidates) : pickRandom(connBank);
          styleTag = 'رد حواري متصل';
        } else if (!isDirectiveSpeechAct) {
          const openCandidates = bank.openers.filter((o) => !o || !usedOpeners.has(normMatch(o)));
          prefix = openCandidates.length > 0 ? pickRandom(openCandidates) : '';
        }

        const closingCandidates = bank.closings.filter((cl) => !cl || !usedClosings.has(normMatch(cl)));
        const closing =
          !isDirectiveSpeechAct && i % 2 === 0 && closingCandidates.length > 0 ? pickRandom(closingCandidates) : '';

        candidate = [prefix, body, closing].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
      }

      const normCand = normMatch(candidate);
      if (candidate && !usedTexts.has(normCand)) {
        text = candidate;
        usedTexts.add(normCand);
        usedBodies.add(normMatch(candidate.split(/[،.]/)[0] || candidate));
        if (useReplyConnector) {
          const firstSeg = candidate.split('،')[0];
          if (firstSeg) usedOpeners.add(normMatch(firstSeg));
        }
        break;
      }
    }

    if (!text) {
      const fallbackPool = selectBodyPool(bank);
      const fallbackBody = fallbackPool[i % fallbackPool.length](ctx);
      text = `${fallbackBody}${!isDirectiveSpeechAct && ctx.topicSnippet && i % 2 === 1 && !fallbackBody.includes(ctx.topicSnippet) ? ` (${ctx.topicSnippet})` : ''}`.trim();
      usedTexts.add(normMatch(text));
    }

    items.push({
      id: `vp_${i + 1}_${crypto.randomBytes(3).toString('hex')}`,
      personaName: persona.name,
      dialect: persona.dialect,
      styleTag,
      text,
    });
  }

  return items;
}
