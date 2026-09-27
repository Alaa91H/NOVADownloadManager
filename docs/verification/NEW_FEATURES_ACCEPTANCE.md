# NEW FEATURES ACCEPTANCE

> سجل قبول تنفيذي مرتبط بالـSHA. لا تُعامل الاختبارات `skipped` أو `not-run` كنجاح، ولا تُغلق أي مهمة قبل استيفاء تعريف الاكتمال في خطة Library الملزمة.

## T00 — استعادة خط أساس قابل للبناء قبل إضافة سلوك

**الحالة:** OPEN

| المهمة | SHA | البيئة | الأمر/السيناريو | النتيجة | الدليل | المتبقي |
|---|---|---|---|---|---|---|
| T00 | `429e7062c9a7ecf3c51672315462c4caf3466c4b` | GitHub Actions / مراجعة 2026-09-27 | خط أساس `main` قبل دمج #208 | فشل | NOVA Unified CI run 36140606217: Rust و6 أهداف desktop فشلت؛ Android نجح | مراجعة #208 وإصلاح baseline |
| T00 | `5df4e443130d56b08fe148157522e94e1f39c8d7` | GitHub Actions / PR #208 | Rust daemon compatibility + desktop matrix | جزئي | run 36148148464: Rust وAndroid نجحا؛ desktop توقف عند accessibility | عدم اعتبار desktop ناجحًا؛ إصلاح focus والبوابات التالية |
| T00 | `97edad744f09856ef885282b14a52117da8a3f77` | GitHub / main | دمج PR #208 بعد مراجعة diff | تم الدمج | PR #208 merged؛ لم تُنسخ تغييرات version منفصلة | إعادة التحقق على main |
| T00 | `fd165c58d953e33c6c515918b669fe32d5973d02` | مراجعة شجرة main | parity evidence paths/tokens | تحقق ساكن | 0 مراجع ملفات مفقودة بعد تصحيح manifest؛ الحالات بقيت conservative و`releaseReplacementReady=false` | يحتاج تشغيل `check-parity.mjs` الفعلي ضمن المرشح |
| T00 | `6da4da2630dad33b7c8c29d3f4b41db55d51301d` | GitHub Actions / Ubuntu | T00 full Rust verification | فشل | run 36344846103: اختبارات `src-tauri` 905/905 نجحت؛ core-model 22/22 نجحت؛ فشل لاحقًا في `nova-media-core` بسبب E0716 في 3 اختبارات selection | إصلاح أعمار fixtures وإعادة تشغيل A بالكامل |
| T00 | `4d4e1c6f5a8ffec82b283e8231043e2ec8c18073` | GitHub Actions | run 36345124558: مجموعة A + مصفوفة B على 6 أهداف | in-progress / not-run بالكامل | run الحالي بدأ على نفس SHA؛ لا توجد نتيجة نهائية بعد | يجب نجاح A وB على المرشح نفسه، وفشل `--require-complete` المتوقع، ثم مراجعة مستقلة |
| T00 | `399f90e1671ac93d31721a3a19730d45a63d395d` | GitHub / Remote Desktop check 2026-09-28 | إعادة تحقق من المرشح الحالي بعد إصلاحات Rust/Qt | blocked / not-run | لا توجد Workflow runs أو commit statuses مرتبطة بهذا SHA عبر GitHub؛ جهاز `Alaa-PC` المصرح به offline، لذلك لم تُشغّل A/B محليًا | استعادة تشغيل CI أو بيئة build مصرح بها ثم تشغيل A وB وparity على SHA واحد؛ لا انتقال إلى T01 |

## ملاحظات T00 المثبتة

- تم دمج #208 إلى `main` بعد فحص diff.
- تم استبدال مرجع `LegacyI18nCatalog` المحذوف بمنطق RTL الحالي، واختبار EN/AR موجود في `NativeParityTests.cpp`.
- أضيف مؤشر focus مرئي مرتبط بتركيز لوحة المفاتيح في `DownloadsPage.qml`.
- صُححت نصوص المنتج التي كانت تُظهر FFmpeg كاسم تنفيذ للمستخدم مع إبقاء المفاتيح الداخلية المتوافقة.
- صُححت مراجع parity إلى الملفات/workflow الفعلية، ولم تُرفع claims غير المثبتة إلى `covered`.
- أضيفت بوابة T00 كاملة لـRust: اختبارات الخادم وكل crates المطلوبة، `fmt` و`clippy -D warnings`.
- أضيف تشغيل `pnpm run native:check` الصريح في desktop CI مع Node 24/pnpm.
- يبقى `check-parity.mjs --require-complete` مطلوبًا أن يفشل في T00 لأن بوابات إنتاج لاحقة ما زالت partial/blocked؛ لا يجوز تغيير `releaseReplacementReady` هنا.

## شروط الإغلاق المتبقية لـT00

- [ ] نجاح مجموعة التحقق A كاملة على SHA واحد.
- [ ] نجاح مجموعة التحقق B على Windows x64/ARM64 وLinux x64/ARM64 وmacOS Intel/Apple Silicon على SHA نفسه.
- [ ] إثبات نجاح `check-parity.mjs` العادي.
- [ ] إثبات أن `check-parity.mjs --require-complete` يفشل للأسباب المتوقعة فقط.
- [ ] حفظ نتائج CI/الأوامر والبيئة والـSHA النهائي هنا.
- [ ] مراجعة مستقلة من منفذ آخر لفرق الكود والعقد ودليل التحقق.
- [ ] لا انتقال إلى T01 قبل إغلاق جميع البنود أعلاه.
