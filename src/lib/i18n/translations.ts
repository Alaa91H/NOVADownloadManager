import { en } from './en';
import { af } from './af';
import { sq } from './sq';
import { am } from './am';
import { ar } from './ar';
import { hy } from './hy';
import { as } from './as';
import { ay } from './ay';
import { az } from './az';
import { bm } from './bm';
import { eu } from './eu';
import { be } from './be';
import { bn } from './bn';
import { bho } from './bho';
import { bs } from './bs';
import { bg } from './bg';
import { ca } from './ca';
import { ceb } from './ceb';
import { ny } from './ny';
import { zh } from './zh';
import { zhTW } from './zh_TW';
import { co } from './co';
import { hr } from './hr';
import { cs } from './cs';
import { da } from './da';
import { dv } from './dv';
import { doi } from './doi';
import { nl } from './nl';
import { eo } from './eo';
import { et } from './et';
import { ee } from './ee';
import { tl } from './tl';
import { fi } from './fi';
import { fr } from './fr';
import { fy } from './fy';
import { gl } from './gl';
import { ka } from './ka';
import { de } from './de';
import { el } from './el';
import { gn } from './gn';
import { gu } from './gu';
import { ht } from './ht';
import { ha } from './ha';
import { haw } from './haw';
import { he } from './he';
import { hi } from './hi';
import { hmn } from './hmn';
import { hu } from './hu';
import { is } from './is';
import { ig } from './ig';
import { ilo } from './ilo';
import { id } from './id';
import { ga } from './ga';
import { it } from './it';
import { ja } from './ja';
import { jw } from './jw';
import { kn } from './kn';
import { kk } from './kk';
import { km } from './km';
import { rw } from './rw';
import { gom } from './gom';
import { ko } from './ko';
import { kri } from './kri';
import { ku } from './ku';
import { ckb } from './ckb';
import { ky } from './ky';
import { lo } from './lo';
import { la } from './la';
import { lv } from './lv';
import { ln } from './ln';
import { lt } from './lt';
import { lg } from './lg';
import { lb } from './lb';
import { mk } from './mk';
import { mai } from './mai';
import { mg } from './mg';
import { ms } from './ms';
import { ml } from './ml';
import { mt } from './mt';
import { mi } from './mi';
import { mr } from './mr';
import { mniMtei } from './mni_Mtei';
import { lus } from './lus';
import { mn } from './mn';
import { my } from './my';
import { ne } from './ne';
import { no } from './no';
import { or } from './or';
import { om } from './om';
import { ps } from './ps';
import { fa } from './fa';
import { pl } from './pl';
import { pt } from './pt';
import { pa } from './pa';
import { qu } from './qu';
import { ro } from './ro';
import { ru } from './ru';
import { sm } from './sm';
import { sa } from './sa';
import { gd } from './gd';
import { nso } from './nso';
import { sr } from './sr';
import { st } from './st';
import { sn } from './sn';
import { sd } from './sd';
import { si } from './si';
import { sk } from './sk';
import { sl } from './sl';
import { so } from './so';
import { es } from './es';
import { su } from './su';
import { sw } from './sw';
import { sv } from './sv';
import { tg } from './tg';
import { ta } from './ta';
import { tt } from './tt';
import { te } from './te';
import { th } from './th';
import { ti } from './ti';
import { ts } from './ts';
import { tr } from './tr';
import { tk } from './tk';
import { uk } from './uk';
import { ur } from './ur';
import { ug } from './ug';
import { uz } from './uz';
import { vi } from './vi';
import { cy } from './cy';
import { xh } from './xh';
import { yi } from './yi';
import { yo } from './yo';
import { zu } from './zu';

export type Language = 'en' | 'af' | 'sq' | 'am' | 'ar' | 'hy' | 'as' | 'ay' | 'az' | 'bm' | 'eu' | 'be' | 'bn' | 'bho' | 'bs' | 'bg' | 'ca' | 'ceb' | 'ny' | 'zh' | 'zh-TW' | 'co' | 'hr' | 'cs' | 'da' | 'dv' | 'doi' | 'nl' | 'eo' | 'et' | 'ee' | 'tl' | 'fi' | 'fr' | 'fy' | 'gl' | 'ka' | 'de' | 'el' | 'gn' | 'gu' | 'ht' | 'ha' | 'haw' | 'he' | 'hi' | 'hmn' | 'hu' | 'is' | 'ig' | 'ilo' | 'id' | 'ga' | 'it' | 'ja' | 'jw' | 'kn' | 'kk' | 'km' | 'rw' | 'gom' | 'ko' | 'kri' | 'ku' | 'ckb' | 'ky' | 'lo' | 'la' | 'lv' | 'ln' | 'lt' | 'lg' | 'lb' | 'mk' | 'mai' | 'mg' | 'ms' | 'ml' | 'mt' | 'mi' | 'mr' | 'mni-Mtei' | 'lus' | 'mn' | 'my' | 'ne' | 'no' | 'or' | 'om' | 'ps' | 'fa' | 'pl' | 'pt' | 'pa' | 'qu' | 'ro' | 'ru' | 'sm' | 'sa' | 'gd' | 'nso' | 'sr' | 'st' | 'sn' | 'sd' | 'si' | 'sk' | 'sl' | 'so' | 'es' | 'su' | 'sw' | 'sv' | 'tg' | 'ta' | 'tt' | 'te' | 'th' | 'ti' | 'ts' | 'tr' | 'tk' | 'uk' | 'ur' | 'ug' | 'uz' | 'vi' | 'cy' | 'xh' | 'yi' | 'yo' | 'zu';

export const translations: Record<Language, Record<string, string>> = {
  'en': en,
  'af': af,
  'sq': sq,
  'am': am,
  'ar': ar,
  'hy': hy,
  'as': as,
  'ay': ay,
  'az': az,
  'bm': bm,
  'eu': eu,
  'be': be,
  'bn': bn,
  'bho': bho,
  'bs': bs,
  'bg': bg,
  'ca': ca,
  'ceb': ceb,
  'ny': ny,
  'zh': zh,
  'zh-TW': zhTW,
  'co': co,
  'hr': hr,
  'cs': cs,
  'da': da,
  'dv': dv,
  'doi': doi,
  'nl': nl,
  'eo': eo,
  'et': et,
  'ee': ee,
  'tl': tl,
  'fi': fi,
  'fr': fr,
  'fy': fy,
  'gl': gl,
  'ka': ka,
  'de': de,
  'el': el,
  'gn': gn,
  'gu': gu,
  'ht': ht,
  'ha': ha,
  'haw': haw,
  'he': he,
  'hi': hi,
  'hmn': hmn,
  'hu': hu,
  'is': is,
  'ig': ig,
  'ilo': ilo,
  'id': id,
  'ga': ga,
  'it': it,
  'ja': ja,
  'jw': jw,
  'kn': kn,
  'kk': kk,
  'km': km,
  'rw': rw,
  'gom': gom,
  'ko': ko,
  'kri': kri,
  'ku': ku,
  'ckb': ckb,
  'ky': ky,
  'lo': lo,
  'la': la,
  'lv': lv,
  'ln': ln,
  'lt': lt,
  'lg': lg,
  'lb': lb,
  'mk': mk,
  'mai': mai,
  'mg': mg,
  'ms': ms,
  'ml': ml,
  'mt': mt,
  'mi': mi,
  'mr': mr,
  'mni-Mtei': mniMtei,
  'lus': lus,
  'mn': mn,
  'my': my,
  'ne': ne,
  'no': no,
  'or': or,
  'om': om,
  'ps': ps,
  'fa': fa,
  'pl': pl,
  'pt': pt,
  'pa': pa,
  'qu': qu,
  'ro': ro,
  'ru': ru,
  'sm': sm,
  'sa': sa,
  'gd': gd,
  'nso': nso,
  'sr': sr,
  'st': st,
  'sn': sn,
  'sd': sd,
  'si': si,
  'sk': sk,
  'sl': sl,
  'so': so,
  'es': es,
  'su': su,
  'sw': sw,
  'sv': sv,
  'tg': tg,
  'ta': ta,
  'tt': tt,
  'te': te,
  'th': th,
  'ti': ti,
  'ts': ts,
  'tr': tr,
  'tk': tk,
  'uk': uk,
  'ur': ur,
  'ug': ug,
  'uz': uz,
  'vi': vi,
  'cy': cy,
  'xh': xh,
  'yi': yi,
  'yo': yo,
  'zu': zu,
};

export function getTranslation(
  lang: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const code = (lang as Language) || 'en';
  const dict = translations[code] || translations['en'];
  let text = dict[key] || translations['en'][key] || key;

  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, String(v));
    });
  }
  return text;
}
