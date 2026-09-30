# NOVA Control Plane API v1

**الحالة:** العقد الأساسي منفذ في daemon. لم تُنقل جميع العملاء إليه بعد، وهذه الوثيقة لا تدعي اكتمال parity.

كل المسارات تتطلب مصادقة daemon الحالية بـ`Authorization: Bearer <token>`. لا ترسل `principal` أو `scopes` في جسم الطلب؛ يبنيها adapter من سياق المصادقة الموثوق. حاليًا يُمثّل bearer المحلي بهوية `local-api` ذات scope إداري واحد؛ scopes تفصل العمليات في العقد لكنها لم تصبح بعد نظام scoped tokens أو RBAC للمستخدمين.

## Commands

يرسل العميل `POST /api/v1/commands` مع غلاف مرقم ومفتاح idempotency فريد لكل عملية منطقية:

```json
{
  "contractVersion": 1,
  "requestId": "client-request-42",
  "idempotencyKey": "add-download-42",
  "command": {
    "type": "addDownload",
    "request": {
      "url": "https://example.org/archive.zip",
      "startImmediately": true
    }
  }
}
```

الأوامر المتاحة حاليًا هي `addDownload`, `addMediaDownload`, `addMediaPlaylist`, `addTorrent`, `storeCredential`, `deleteCredential`, `updateTask`, `pauseTask`, `resumeTask`, `retryTask`, `redownloadTask`, `deleteTask`, `moveTask`, `setTaskPriority`, `startQueue`, `stopQueue`, `createQueue`, `updateQueue`, `deleteQueue`, `reorderQueues`, `reorderQueueTasks`, `setActiveProfile`, `upsertProfile`, `deleteProfile`, `addRule`, `deleteRule`, `addSchedule`, `updateSchedule`, `deleteSchedule` و`setSchedulerPowerCommands`. إنشاء قائمة الوسائط أمر واحد ذو idempotency key؛ تُنشأ عناصرها عبر bus نفسه، وتعيد المحاولة النتيجة السابقة بدل تكرار المهام خلال عمر سجل idempotency. `retryTask` يعيد تشغيل المهمة المتوقفة أو الفاشلة باستخدام مسار الاستئناف الموجود، ويحافظ على البيانات الجزئية عندما تسمح آلية المحرك بذلك؛ `redownloadTask` عملية منفصلة تعيد التنزيل من البداية وتتطلب صلاحية حذف الملفات. حذف المهمة من القرص يحتاج إلى `deleteFiles: true` ويُطلب له scope منفصل داخل نموذج الصلاحيات. Priority يأخذ قيمة من 0 (critical) إلى 4 (background). إدارة Queue تتطلب `queueManage`؛ إنشاء/تحديث الطابور يمر عبر التطبيع الحالي، والترتيب يتطلب كل العناصر الموجودة مرة واحدة، وحذف queue غير main يعيد مهامه إلى main. إدارة Profiles تتطلب `profileManage`؛ تغيير Profile يطبّق سياسة retry وحد النطاق الترددي وينشر حدث تبديل Profile، وتحترم الإضافة/التحديث معرفات Profiles المضمنة المحجوزة. إدارة قواعد التنزيل تتطلب `rulesManage` ويطبّق Runtime تحقق المحرك المعتاد قبل حفظ القاعدة. إدارة الجدولة تتطلب `scheduleManage`؛ تظل قرارات الجدولة والتعامل مع إجراءات النظام في خدمة Scheduler القائمة.

`storeCredential` يستقبل `credentialId` مقيدًا و`secret` تحت نطاق `credentialManage`، ويخزن القيمة في Windows Credential Manager أو macOS Keychain أو Linux Secret Service حسب build backend. `deleteCredential` يحذف المرجع نفسه؛ لا توجد Query لإرجاع الأسرار، ونتائج الأوامر لا تحتوي قيمها. قيم الأسرار لا تكتب في لقطة JSON أو الأحداث، ويعرض فشل/قفل مخزن النظام خطأ عامًا قابلًا لإعادة المحاولة. بعد نجاح العملية ينشر Event Bus `credential.stored` أو `credential.deleted` مع `actorId` ونتيجة الحذف؛ يحجب المنفذ `credentialId` قبل الحفظ والبث، ولا يتضمن الحدث السر. يستخدم Desktop الآن الأمرين نفسيهما لإضافة/استبدال سر وحذفه من لوحة الإعدادات، ويمسح خانة السر بعد الإرسال أو إخفاء اللوحة؛ ويقرأ CLI السر من stdin غير التفاعلي فقط عبر `nova credential store <id>` دون وضعه في الوسائط أو الطرفية. لم يتوفر بعد Query لسرد المعرّفات أو ربطها بمهام التنزيل وNetwork Profiles، كما لم يكتمل adapter Android وTelegram لإدارة الأسرار.

يقبل الأمر `batch` حتى 128 عملية من دون batches متداخلة. `bestEffort` ينفذ كل عنصر ويعيد نجاح/فشل كل عنصر. `atomic` يرفض حاليًا بـ`501 atomic_batch_unavailable`؛ لا تدعي الواجهة ذرية لا توفرها خدمات المحركات.

تتضمن الاستجابة الناجحة `contractVersion`, `requestId`, `idempotencyKey`, `replayed` و`result`. إعادة الطلب بالمفتاح نفسه والحمولة نفسها تعيد النتيجة المحفوظة ولا تعيد تنفيذ الأثر. إعادة استخدام المفتاح لحمولة مختلفة يعيد `409 idempotency_key_reused`. بصمات الطلب keyed HMAC بمفتاح عشوائي للعملية، وتمسح نسخة JSON المرمزة بعد حسابها حتى لا تخزن بصمة غير keyed لقيمة credential منخفضة العشوائية. نتائج idempotency ما زالت في الذاكرة لمدة 24 ساعة وبحد أقصى 4096 مفتاحًا؛ لا يوجد replay لها بعد restart حتى تنتقل إلى مخزن دائم آمن.

لا تُخزّن الأخطاء المؤقتة التي تحمل `retryable: true` في سجل idempotency، لذلك يستطيع العميل إعادة المحاولة بالمفتاح نفسه بعد زوال عطل عابر. أخطاء التحقق والتعارض الدائمة تبقى نتائج قابلة لإعادة التشغيل. رفض Profile أو Rule أو Schedule يُعاد كـ`StructuredError` بدل نجاح HTTP مع `{ "ok": false }`. إنشاء Schedule يرفض المعرف المكرر، والتحديث يرفض معرفًا غير موجود، وحذف Schedule/Rule غير الموجود آمن ومتكرر ويعيد `removed: false`. تعديل Profile النشط يعيد تطبيق retry/bandwidth، وحذفه يرجع ذريًا إلى Profile `balanced` ويعيد تطبيق سياسته وينشر حدث التغيير. يتحقق Profile Manager من حدود الاتصالات (1–512) وسياسة retry (100 محاولة، تأخير 1 ساعة/24 ساعة، وbackoff من 1 إلى 10) والعتبات والقيم الأساسية قبل الحفظ؛ تطبّع القيم القديمة أثناء الاستعادة. يفرض محرك الاتصالات سقف 512 اتصالًا لكل مهمة حتى لو وصل إليه إعداد Profile غير موثوق.

كل خطأ يعيد غلافًا يحوي `contractVersion`, `requestId` و`error`، ويعرض الأخير `code`, `message`, `httpStatus`, `retryable`, `replayed` و`details`.

تعيد `GET /api/engine/capabilities` سجل `controlPlane.commandCapabilities` من نفس عقد Rust، مع حالة `supported` أو `unavailable` وملاحظة عن القيود، إلى جانب الاستعلامات المتاحة وسعة idempotency. السجل يصف daemon فقط؛ ولا يعني أن كل واجهة عميلة تملك adapter لهذه الأوامر.

## Queries

يرسل العميل `POST /api/v1/queries` بغلاف `contractVersion`, `requestId` و`query`. الأنواع المتاحة: `capabilities`, `listQueues`, `listProfiles`, `getProfile`, `listRules`, `listSchedules`, `getTask`, `listTasks`, `diagnostics`, `recentLogs` و`events`.

مثال لصفحات المهام:

```json
{
  "contractVersion": 1,
  "requestId": "client-query-7",
  "query": {
    "type": "listTasks",
    "filter": {
      "status": ["queued", "downloading"],
      "queueId": "main",
      "limit": 100
    }
  }
}
```

تدعم قائمة المهام التصفية بالحالة والطابور والفئة. تُرتب النتائج حسب task ID وتستخدم cursor من آخر ID في الصفحة؛ هذا keyset cursor لا يبطل بسبب تحديث progress متكرر. النتائج والإجمالي live وقد يتغيران إذا تغيرت المهام بين الطلبات. حد الصفحة الأقصى 1000.

Cursor الأحداث هو رقم event ID مستمر عبر إعادة تشغيل daemon. يعيد API v1 كل حدث في envelope له `schemaVersion`, `eventId`, `eventType` dot-case و`taskId` و`timestampMillis` و`data` بأسماء camelCase. يحجب Runtime بيانات الاعتماد وquery strings قبل حفظ الأحداث أو إرجاعها، ويضم سجلًا محدودًا إلى 10,000 حدث في لقطة الحالة الذرية. يحافظ الاسترجاع على ترتيب IDs ويعيد 410 مع أول cursor متاح إذا خرج المطلوب من السجل. تحفظ اللقطة عند تغيّر الحالة ودوريًا وفق مسار persistence الحالي، لذلك قد يفقد إنهاء قسري آخر أحداث لم تصل إلى آخر لقطة. تبقى المسارات القديمة متاحة خلال نقل العملاء إلى API v1.

## Scope of the first adapter

هذه العقود ونقطة API لا تكمل وحدها CP-02. الإضافة المباشرة والوسائط وقوائمها والتورنت وعمليات task الأساسية وإدارة Queue كاملة وإدارة Profiles وقواعد التنزيل والجدولة وكتابة/حذف credentials عبر مسارات API القديمة تمر الآن عبر bus نفسه؛ تقبل handlers المناسبة ترويسة `Idempotency-Key` اختيارية، وتستخدم مفتاحًا فريدًا عند غيابها. سطح Desktop الحالي يستخدم هذه المحوّلات القديمة التي تنتهي بالـbus، وتدعم لوحة الإعدادات كتابة credential وحذفه عبر الأوامر المشتركة. CLI محلي في `crates/nova-cli` يقرأ capability registry ويرسل أوامر/استعلامات v1 ويغطي التنزيل والوسائط والتورنت وQueue وProfiles وRules وScheduler والأحداث والتشخيصات والسجلات المنقحة؛ أضيفت كتابة credential من stdin وحذفها، ولم تكتمل بقية parity. Network Profiles والإعدادات الموحدة ما زالت غير متاحة في contract. Telegram يمرر حاليًا add/media/pause/resume/retry/delete/move/priority/startQueue/stopQueue وعمليات الإدارة الموسعة عبر bus، ويستخدم Queries المشتركة؛ كما يتلقى إشعارات completion/failure من Runtime Event Bus عبر قناة محدودة من دون منطق تنزيل منفصل. Android ما زال يستخدم JNI runtime محليًا منفصلًا، ولا يوجد تخزين idempotency دائم. سجّل Runtime إصدار Control Plane وendpoint names وحالة atomic batches كيلا تعرض الواجهات قدرات غير موجودة.

رموز التصميم الأساسية معرفة في `design-system/nova-design-tokens.json`، وتولد مخرجات QML وCompose عبر `node scripts/generate-design-tokens.mjs`; فحص CI يستخدم `--check`. يبقى اختيار Android للألوان الديناميكية اختياريًا على مستوى النظام، بينما الثيمات الافتراضية وعالي التباين تستهلك الرموز المشتركة. تحفظ اللقطة أيضًا Profiles المخصصة والـProfile النشط والـqueues والجداول المعروفة؛ تبقى Rules خارج التخزين المشترك حاليًا لأن `AddHeader` قد يحمل أسرارًا ويحتاج أولًا إلى Credential Manager آمن.
