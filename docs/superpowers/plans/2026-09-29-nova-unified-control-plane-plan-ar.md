# NOVA Unified Control Plane Implementation Plan

> **For agentic workers:** استخدم `executing-plans` لتنفيذ كل مرحلة بترتيبها وباختباراتها. هذه الخطة تجمع مسارات مترابطة في milestones مستقلة؛ لا تعتبر علامة التوثيق تنفيذًا للمنتج.

**Goal:** توحيد إدارة NOVA حول عقود Runtime Rust versioned، وتقديم القدرات نفسها عبر API والعملاء المطلوبة مع سجل صريح للتوافر والقيود.

**Architecture:** يملك Rust النماذج والسياسات والتحقق والحالة وسجل الإمكانيات وحافلة الأحداث. API adapters تستقبل Commands وQueries typed، والعملاء يعرضون نتيجة runtime capabilities دون إعادة تنفيذ business logic. يبدأ التحكم محليًا؛ لا يفتح Remote API قبل اكتمال حد الأمان.

**Tech Stack:** Rust workspace (`nova-core-model`, media/download/torrent cores, Axum daemon)، Qt 6/QML/C++، Android Kotlin/Compose/UniFFI، TypeScript/Node، pnpm وGitHub Actions.

**Spec:** [`docs/architecture/NOVA_UNIFIED_CONTROL_PLANE_AR.md`](../../architecture/NOVA_UNIFIED_CONTROL_PLANE_AR.md)

## سجل التنفيذ الحالي — 2026-09-30

هذه الخطة ما زالت **قيد التنفيذ**؛ الحالات التالية تصف العمل الموجود في الشجرة ولا تعني اجتياز التحقق أو اكتمال parity:

- **متابعة CP-01:** أضاف daemon سجل capabilityRegistry موحدًا بإصدار 2 بعقد JSON Schema مشتق من حالات libcurl ومحرك الوسائط والتورنت وأوامر التحكم الفعلية، ويضم المنصة والقيود والسبب والعمليات والأحداث ومراجع المصدر. يتحقق browser-extension من العقد ويحوّل حالات direct/media/streaming/torrent إلى خياراتها؛ ويعيد Android FFI مجموعة المعرفات نفسها بحالات build-specific ويستهلكها MediaViewModel لمنع خيارات التحويل غير المتاحة؛ وتستخدم QML السجل لمنع خيارات media/batch غير المدعومة. يرفض منفذ Core الإضافات إذا لم يسجل Runtime capability على أنها supported، ويتحقق CLI من إصدار السجل مبكرًا ويعرض Telegram ملخصه.
- **متابعة CP-04:** أضيف إلى Telegram استعلامات `/inspect` و`/events` و`/logs` عبر Query contract المشترك؛ يعرض الأول حالة المهمة ومؤشراتها دون URL أو رسالة خطأ خام، والثاني يعرض أحداثًا منقحة مع cursor للاستمرار أو للاسترداد بعد انتهاء الاحتفاظ، والثالث سجلات منقحة ومحدودة الطول. تبقى clientAdapters فارغة حتى توثيق parity بالأدلة، وتظل CP-01 جزئية.
- **متابعة CP-03/CP-05:** أصبحت أحداث `rule.applied` تربط قرار القاعدة بمعرّف المهمة وتذكر نوع الإجراء فقط، كي لا تسجل قيمة header أو المسار أو mirror داخل الحدث. يبقى تطبيق Rules خارج المسار المباشر/الميديا أحادي المهمة غير موحد بعد، كما لا تحفظ القواعد نفسها ضمن snapshot؛ لا يثبت هذا التعديل parity أو استعادة Rules.

- **CP-01 جزئي:** Runtime يعلن Control Plane command/query capabilities، وسجل media native مأخوذ من قدرات codecs المبنية. يوجد manifest وفاحص CI يمنعان إضافة command/query/event غير مسجل أو وسمه `complete` بلا تغطية العملاء وأدلة اختبارات العقود.
- **CP-02 جزئي:** عقود v1 وCommand Bus وpermission scopes وidempotency داخل العملية وbest-effort batch موجودة. لا يزال RBAC/scoped-token store غير منفذ، وatomic batch غير متاح.
- أوامر Profiles وRules وScheduler عبر Command Bus تعيد الآن أخطاء منظّمة عند الرفض/غياب العنصر، وتتحقق من تعارض معرفات الجدولة ونطاق TimeWindow؛ الأخطاء المؤقتة القابلة لإعادة المحاولة لا تُحجز تحت idempotency key.
- يعيد تعديل Profile النشط تطبيق retry/bandwidth، وحذفه يبدل ذريًا إلى `balanced` ويعيد تطبيق السياسة وينشر الحدث. يفرض المحرك سقف 512 اتصالًا للمهمة حتى مع إعداد Profile غير موثوق.
- يتحقق Profile Manager من connection/retry/threshold/segment bounds قبل قبول التعديلات؛ القيم القديمة المستعادة تطبّع إلى حدود runtime الحالية بدل إسقاط Profile كاملًا.
- **CP-03 جزئي:** envelopes للأحداث وتنقيحها وsnapshot بحد أقصى 10,000 حدث وIDs مستمرة، مع حفظ Profiles المخصصة والـprofile النشط. مفاتيح idempotency ما زالت مؤقتة؛ Rules وcredential state لا تحفظ قبل Credential Manager آمن.
- **CP-04 جزئي:** Desktop يستخدم v1 لأوامر وQueries مختارة، وCLI وTelegram يمرران العمليات المشتركة عبر bus؛ Telegram يتلقى حاليًا إشعارات الإكمال والفشل من Event Bus. فاحص parity يسجل Android gaps لأن تطبيقه ما زال يستخدم runtime JNI محليًا منفصلًا؛ لا تعتبر القائمة إثباتًا لتكافؤ العملاء.
- **CP-08 جزئي:** design tokens موحدة تولد موارد QML وCompose ويكشف CI المخرجات القديمة.
- أضيفت Queries مشتركة للتشخيصات والسجلات المنقحة، وأوامر CLI مباشرة للتحكم بالمهام. Network Profiles والإعدادات الموحدة غير متاحة بعد.
- حسب توجيه المستخدم الحالي، **لم تُشغّل اختبارات أو أوامر بناء**. الفحص المنفذ محصور في parsing/التنسيق الساكن، JSON وmanifest consistency و`git diff --check`.

تظل CP-05 إلى CP-10 وبقية متطلبات parity والـmedia/torrent/network/security/headless/remote/Android غير مكتملة حتى تنفيذها والتحقق منها على منصاتها. لا تستخدم هذه الملاحظات لاعتبار أي capability جاهزة للإصدار.

## Global Constraints

- Rust هو المصدر الوحيد للحقيقة عن capability المتاحة؛ لا تعلن الواجهة قدرة غير موجودة في registry.
- لا تعتمد Media الأساسية على executable خارجي، ولا يوجد fallback صامت.
- تبقى Local Loopback وRemote API حدودًا منفصلة؛ لا خدمة remote قبل TLS والمصادقة والصلاحيات والتدقيق والحد من المعدل.
- كل contract versioned، وكل تغيير breaking يتطلب migration وتوافقًا خلفيًا معلنًا.
- تبقى حالات lifecycle الدقيقة ظاهرة عبر API والعملاء؛ لا تختزلها الواجهة.
- parity يقاس لكل capability ولكل منصة مطلوبة، وتظل المنصة المقيدة موثقة مع البديل.
- تنفذ تغييرات التحقق الخاصة بهذه المهمة من GitHub Actions حسب توجيه المستخدم؛ تسجل نتائجها على SHA بعينه.

## Review Focus

- capability اسمها موجودة لكن التنفيذ الحقيقي غير متاح: اختبار registry يستمدها من المحرك ويعرض `unavailable` مع سبب.
- يعاد إرسال Command بعد timeout: اختبار idempotency يمنع تكرار المهمة أو آثارها.
- client أقدم يستهلك contract أحدث: اختبار توافق/migration يبقي التعامل مع الإصدارات المدعومة محددًا.
- يتوقف VPN أو يفشل Destination: اختبار fail-closed أو recovery لا يسمح fallback غير مقصود أو task مكتملة كذبًا.
- استثناء منصة أو خطأ task يحتوي secret: اختبار parity/redaction يمنع تسريب الإعدادات الحساسة.

## ترتيب التنفيذ والملفات الرئيسية

### CP-01 — Capability Registry وParity Gate

**الملفات:** `crates/nova-core-model/src/lib.rs`, `crates/nova-media-processing-core/src/native_codecs.rs`, `src-tauri/src/daemon/engine_capabilities.rs`, `scripts/check-runtime-contract.mjs`, `desktop-native/parity/parity-manifest.json`, `.github/workflows/nova-ci.yml`.

- عرف `CapabilityEntry` و`CapabilityStatus` بإصدار وعناصر المنصة والعملاء والقيود وسبب عدم التوافر وأدلة العقد والاختبار.
- حوّل القدرات الحالية من direct/media/torrent/network إلى registry واحد؛ استمد codecs والحاويات من runtime engine registry، وأظهر demux/mux وencoders/decoders والصيغ المدعومة والقيود. أي قدرة لا يقدمها المحرك تعلن `unavailable` بدل قائمة توقعية.
- أضف اختبارًا يثبت اتساق `supportedMediaOptionKeys` والـregistry مع validators والمنفذات الفعلية، واختبار contract version وشكل الـresponse.
- اربط manifest parity بالـregistry وبالاختبارات والمحولات المطلوبة. اجعل CI يفشل على capability مستقرة ليس لها owner أو adapter evidence، مع السماح لـplatform exception موثق.

**القبول:** query واحد من Runtime يعيد registry مرقمًا ودقيقًا. كل codec/container معروض يمر من نفس preflight المستخدم في التنفيذ، ويمنع CI معرفًا مجهولًا أو status غير متسق.

### CP-02 — Queries ثم Command Bus محلي

**الملفات:** `crates/nova-core-model/src/lib.rs`, `src-tauri/src/daemon/mod.rs`, ملفات `src-tauri/src/daemon/routes/*.rs`, `src-tauri/src/daemon/engine/`.

- عرف `CommandEnvelope`, `Principal`, `CommandScope`, `CommandResult`, `StructuredError`, و`QueryPage` في model مشترك.
- أنشئ `CommandBus` في طبقة خدمات Rust، مع validator واحد لكل command، صلاحيات، idempotency store وحدود batch. انقل add/pause/resume/delete/retry/priority/move إلى خدمات domain تستدعيها routes الحالية وv1.
- افصل read-only queries (list/details/capabilities/events) عن command handlers، وأضف cursor pagination وfilters وعمليات batch محدودة الحجم.
- أضف routes `/api/v1/...` مع schemas واختبارات contract؛ أبقِ المسارات الحالية adapters إلى الخدمة نفسها خلال migration.
- اختبر anonymous/invalid scope وpayload ناقص/خاطئ، replay لنفس idempotency key، batch جزئي أو ذري حسب نوع العملية، وحدود pagination.

**القبول:** لا route ولا adapter يستدعي محركًا لتطبيق business logic منفردًا؛ كل تغيير حالة يمر من bus نفسه مع خطأ منظم وهوية تنفيذ قابلة للتدقيق.

### CP-03 — Event Bus وLifecycle وديمومة الحالة

**الملفات:** `src-tauri/src/daemon/engine/event_bus.rs`, `crates/nova-core-model/src/lib.rs`, `src-tauri/src/daemon/persist.rs`, `src-tauri/src/daemon/routes/engine.rs`, `.github/workflows/nova-ci.yml`.

- اصدر event envelope مرقمًا باسم dot-case وschema version وsequence/id/task/node/request IDs.
- وصل domain transitions للأحداث الأساسية، وأضف replay/cursor semantics وredaction قبل الحفظ أو البث.
- احفظ commands غير المتزامنة والـevent offsets والـtasks/queues/schedules/rules/profiles عبر كتابة ذرية ومخططات ترحيل.
- اختبر restart/partial write/duplicate replay، وضمان transition كامل من queued إلى verifying/finalizing إلى completed/error.
- أضف event contract tests وأمثلة Desktop/Android/Telegram للتنبيهات دون إضافة business rules في العملاء.

**القبول:** بعد process kill/restart تظهر الحالة السابقة مرة واحدة، وتعيد event subscription الأحداث بعد cursor دون إسقاط أو تكرار غير معرف.

### CP-04 — Clients وShared Contracts

**الملفات:** `desktop-native/src/api/NovaApiClient.cpp`, `android/app/src/main/java/com/nova/downloadmanager/`, `crates/nova-mobile-ffi/src/lib.rs`, `src-tauri/src/daemon/telegram.rs`, `src-tauri/src/daemon/routes/telegram_routes.rs`, `browser-extension/src/`, و`crates/nova-cli/` الجديدة.

- اجعل كل adapter يستعلم عن registry أولًا ويستخدم command/query envelopes المشتركة.
- أكمل واجهة CLI كـclient Rust مستقل (`crates/nova-cli/`) بأوامر add/list/inspect/pause/resume/retry/queue/profile/schedule/rules/network/torrent/media/config/diagnostics/logs/events، مع اختبارات contract عبر daemon محلي.
- وسع Telegram لإدارة queue/schedule/profile/network/torrent/media/bandwidth/retries/diagnostics/actions ضمن scopes، مستخدمًا bus وevent subscriptions نفسيهما.
- اربط Qt وAndroid إلى versioned schemas، واظهر lifecycle/available/unavailable/experimental/platformRestricted دون نسخ سياسات الأعمال.
- أبقِ Extension لالتقاط المصدر والإضافة فقط، ويستعمل نفس API Commands ويدعم idempotency.
- اختبر adapter behavior على payloads حقيقية/fixture versioned؛ parity report يبين gaps لكل قدرة.

**القبول:** Add من أي client ينتج نفس Task state وvalidation/error، وPause/Retry وbatch لها النتيجة ذاتها عند استخدام نفس scope.

### CP-05 — Queue وProfiles وRules وScheduler 2.0

**الملفات:** `src-tauri/src/daemon/routes/queues.rs`, `src-tauri/src/daemon/engine/`, `src-tauri/src/daemon/persist.rs`, `desktop-native/qml/pages/QueuePage.qml`, `desktop-native/qml/components/QueueSettingsPanel.qml`, `android/app/src/main/java/com/nova/downloadmanager/downloads/NovaTransferCore.kt`, `android/app/src/main/java/com/nova/downloadmanager/app/`.

- وحّد ترتيب queue وأولويتها وmax-active والسرعة وretry/profile/schedule/completion action.
- اجعل profile قابلًا للتركيب ويحدد segmentation/adaptation/retry/bandwidth/checksum/network/post-processing.
- وسع scheduler لحالات once/daily/weekly/custom days وtimezone/DST وmissed-run policy وقيود الشبكة والطاقة/الشحن والخمول والنطاق، وأفعال shutdown/sleep/exit وwebhook/script بإعداد صريح.
- اجعل Rules engine في Rust بمطابقة URL/host/extension/size/header وإجراءات category/priority/connections/path/profile/rate/header/mirror/checksum/reject.
- أضف اختبارات قواعد متعارضة/ترتيب الأولوية وDST وقيود غائبة/متغيرة وrestart واستدعاء من كل مصدر إضافة.

**القبول:** إضافة المصدر نفسه من UI أو API أو Telegram تخضع لنفس Rule ثم Queue ثم Profile، مع سبب القرار محفوظًا في timeline.

### CP-06 — Network Profiles وCredential Security

**الملفات:** `src-tauri/src/daemon/engine_capabilities.rs`, `src-tauri/src/daemon/`, `crates/nova-core-model/src/lib.rs`, `desktop-native/src/`, `android/app/src/main/java/com/nova/downloadmanager/`.

- عرف `NetworkProfile` بproxy chain/auth/bypass/DNS/IP preference/interface/VPN binding/kill-switch/failover/domain rules وبمرجع secret لا قيمة secret.
- نفذ دعم proxy/DNS من libcurl runtime capabilities؛ DoH/DoT وhealth/latency/fallback/cache والـbinding أعلنها حسب backend/platform فقط، مع اختبارات DNS leak.
- نفذ اختيار VPN وauto pause/resume وfail-closed وقياس endpoint الفعلي من مسار Runtime دون السماح بتسرب fallback صامت.
- أضف Credential Manager للأسرار بمخزن النظام المناسب، scopes وexpiry/rotation وaudit وredaction.
- أضف اختبارات resolver/IPv4-IPv6/interface/bypass/credentials/leak/killswitch لكل backend يدعمها.

**القبول:** تذكر المهمة Network Profile المختار وسبب fallback أو التوقف، ولا يظهر secret في config export أو logs أو الأحداث.

### CP-07 — Native Media وTorrent Capability Parity

**الملفات:** `crates/nova-media-core/`, `crates/nova-media-processing-core/`, `src-tauri/src/daemon/native_media.rs`, `src-tauri/src/daemon/routes/probes.rs`, `src-tauri/src/daemon/engine_capabilities.rs`, `crates/nova-torrent-core/`, Android media integration وQt `MediaAdvancedPanel.qml`.

- اجعل MediaRequest/Selection/ConversionRequest/CodecRegistry/MediaJob عقودًا مشتركة مرقمة، وتستعملها كل الواجهات.
- اعرض جودة/دقة/FPS/stream/audio/subtitles/codec/container فقط من source probe الفعلي أو native registry، دون قيم ثابتة. ارفض stream لا يمكن تنفيذه.
- نفذ direct/remux/transcode/audio extract/hybrid داخل العملية native. افحص compatibility قبل إنشاء المهمة، واختر remux إذا لم تلزم إعادة ترميز. لا تعلن كل التنسيقات قبل إثباتها.
- ضع HLS/DASH/playlist/subtitles/conversion/batch ضمن Task lifecycle/queue/scheduler/recovery مع CPU/bandwidth limits حيث تتوفر.
- وحّد Magnet/torrent metainfo/file priorities/peers/DHT/seeding policies والتفويض عبر API/CLI/Qt/Telegram، وأظهر قيد Android ما دام adapter غير موصول.
- أضف اختبارات codec/container compatibility, timestamps/A-V sync, large files, interrupted/crash recovery, corrupted media, HDR metadata preservation, multichannel, subtitles وHLS/DASH.

**القبول:** كل خيار يظهر في العميل ينجح في preflight من نفس core؛ codec/container غائب معلن غير متاح، ولا يعمل مسار subprocess كبديل.

### CP-08 — Design Tokens وPlatform Destinations

**الملفات:** `desktop-native/qml/Theme.qml`, `android/app/src/main/java/com/nova/downloadmanager/design/NovaTheme.kt`, `NovaTypography.kt`, `NovaShapes.kt`, `NovaIcons.kt`, `scripts/`, `desktop-native/parity/parity-manifest.json`.

- أنشئ schema `nova-design-tokens` واحدة للألوان والمسافات والخطوط والزوايا والحالات والأيقونات والحركة والكثافة والثيمات.
- ولّد QML singleton وCompose token source من schema نفسها، وأضف `--check` في CI لفشل المخرجات القديمة.
- عرف `Destination` adapters لfilesystem وSAF وMediaStore وapp-private والمجلدات mounted؛ احفظ staging قابلة للاستئناف.
- وحّد overwrite/skip/rename/resume/duplicate/name sanitization/free-space؛ اختبر إلغاء وإبطال grant وامتلاء المساحة وatomic publish.

**القبول:** قيم المنصتين مشتقة من schema واحدة، وكل ملف نهائي منشور بعد verification ونجاح destination finalization.

### CP-09 — Headless/Remote Nodes وObservability

**الملفات:** `src-tauri/src/bin/`, `src-tauri/src/daemon/`, `src-tauri/src/daemon/engine/event_bus.rs`, `docs/`, `.github/workflows/nova-ci.yml`.

- افصل تشغيل Rust Runtime/headless عن Qt process على Linux أولًا، ثم وثق مصفوفة NAS/VPS/Raspberry Pi حسب أهداف البناء.
- لا تعرض remote bind قبل endpoint مستقل مع TLS/mTLS, scoped tokens, RBAC, rate limiting, audit وbrute-force defenses.
- أضف node identity/health/availability وrouting صريحًا لمكان المهمة، مع حفظ `nodeId` ضمن Task/events.
- أنشئ structured logs/metrics/task timeline/segment وretry history وnetwork diagnostics ودليل registry وبناء وحزمة تشخيص محجوبة الأسرار.
- أضف health checks لـstuck transfers/state corruption/engine failures مع إجراءات self-healing آمنة ومحدودة وتسجل السبب.
- أضف export/import/backup مرقم schema مع verify ومفاتيح تشفير خارج ملف التصدير.

**القبول:** يمكن تشغيل core بلا UI، وتبقى واجهة الشبكة مغلقة افتراضيًا. اختبارات صلاحية tokens والتدوير وredaction والاستعادة تسبق قبول remote nodes.

### CP-10 — Contract and Release Gates

**الملفات:** `.github/workflows/nova-ci.yml`, `desktop-native/parity/parity-manifest.json`, `scripts/check-runtime-contract.mjs`, `docs/android/feature-parity.md`, `docs/architecture/NOVA_UNIFIED_CONTROL_PLANE_AR.md`.

- شغل Core tests ثم API contract ثم adapter tests لكل capability stable.
- أنشئ تقرير parity من manifest على SHA، وسجل `supported/unavailable/experimental/platformRestricted` وسبب gaps.
- افشل CI عند contract break غير مرقم، option يعرض بلا backend، أو capability مستقرة ناقصة tests/adapter/documentation.
- أبقِ release gate مغلقًا حتى نجاح أهداف المنصات والأجهزة المطلوبة؛ artifacts وpreview وحدها ليست إثباتًا.

**القبول:** CI يخرج جدول parity مفصلًا، ولا يمكن وسم الميزة `complete` يدويًا لتجاوز فشل العقد أو التحقق.

