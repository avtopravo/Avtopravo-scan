// Разбор текста СТС после распознавания (OCR). Работает в браузере и в Node (для тестов).
// Возвращает ТОЛЬКО поля машины из белого списка. ФИО и адрес владельца сюда не попадают
// никогда: парсер их не ищет, а всё, что не разобрано, остаётся на телефоне.
//
// На настоящем СТС защитная сетка искажает текст: «Марка» читается как «Mapka», слова слипаются.
// Поэтому подписи ищутся с допуском на ошибки, а для части полей есть запасные способы
// без подписей (список цветов, список марок, повтор VIN и т. д.).
(function (root) {
  const CYR2LAT = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C",
                    Т: "T", У: "Y", Х: "X" };
  const LAT2CYR = Object.fromEntries(Object.entries(CYR2LAT).map(([c, l]) => [l, c]));
  const PLATE_LETTERS = "АВЕКМНОРСТУХABEKMHOPCTYX";
  // латинские буквы, которые распознаватель путает с кириллицей, для поиска подписей
  const LOOK = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т",
                 x: "х", y: "у", u: "и", n: "п", r: "г", "ё": "е" };

  const toLatin = (s) => s.toUpperCase().replace(/[АВЕКМНОРСТУХ]/g, (c) => CYR2LAT[c]);
  const toCyr = (s) => s.toLowerCase().replace(/[a-zё]/g, (c) => LOOK[c] || c);

  function lines(text) {
    return text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  // Строка без пробелов и знаков, латиница переведена в кириллицу; idx[i] = позиция в исходной строке
  function squash(line) {
    let sq = "", idx = [];
    for (let i = 0; i < line.length; i++) {
      const c = toCyr(line[i]);
      if (/[а-я]/.test(c)) { sq += c; idx.push(i); }
    }
    return { sq, idx };
  }

  // Поиск подстроки с ошибками (алгоритм Селлерса). Возвращает конец совпадения или -1
  function fuzzyEnd(text, pat, maxErr) {
    const m = pat.length;
    let prev = Array.from({ length: m + 1 }, (_, i) => i), best = Infinity, end = -1;
    for (let j = 1; j <= text.length; j++) {
      const cur = [0];
      for (let i = 1; i <= m; i++) {
        cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1));
      }
      if (cur[m] <= maxErr && cur[m] < best) { best = cur[m]; end = j; }
      prev = cur;
    }
    return end;
  }

  // Значение после подписи (на той же строке или на следующей). Подпись ищется с ошибками
  function after(ls, label, minLen = 2) {
    const pat = toCyr(label).replace(/[^а-я]/g, "");
    const maxErr = pat.length <= 5 ? 1 : pat.length <= 10 ? 2 : 3;
    for (let i = 0; i < ls.length; i++) {
      const { sq, idx } = squash(ls[i]);
      const end = fuzzyEnd(sq, pat, maxErr);
      if (end < 0) continue;
      let rest = ls[i].slice(idx[end - 1] + 1)
        .replace(/^\s*\([^)]*\)/, "")            // «Категория ТС (A, B, C, D, прицеп)»
        .replace(/^[\s:.,;№N°#*-]+/, "")
        .replace(/^(серия|ceрия)\s*№?\s*/i, "")
        .trim();
      if (rest.length >= minLen) return rest;
      if (i + 1 < ls.length) return ls[i + 1];
    }
    return "";
  }

  const fixVinChars = (s) => toLatin(s).replace(/[\s-]/g, "").replace(/O/g, "0")
    .replace(/[IL|]/g, "1").replace(/Q/g, "0");
  // VIN это целое «слово» ровно из 17 символов, в нём есть и буквы, и цифры
  const VIN_RE = /(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/g;
  const vinOk = (v) => /[A-Z]/.test(v) && /\d/.test(v);

  function findVin(ls) {
    const labelled = ls.findIndex((l) => /VIN|Идентиф/i.test(l));
    const order = labelled >= 0 ? [labelled, labelled + 1, ...ls.keys()] : [...ls.keys()];
    for (const i of order) {
      if (i >= ls.length || /Паспорт|СТС|Свидетельство/i.test(ls[i])) continue;
      const cand = fixVinChars(ls[i].replace(/.*(VIN|Идентификационный номер)\s*\(?VIN\)?/i, ""));
      for (const m of cand.match(VIN_RE) || []) if (vinOk(m)) return m;
    }
    return "";
  }

  function countVin(ls, vin) {
    return ls.reduce((n, l) => n + (fixVinChars(l).match(VIN_RE) || []).filter((v) => v === vin).length, 0);
  }

  // «AUDI Аб» -> «AUDI A6»: если марка латиницей, похожие кириллические буквы и цифры
  // в остальных словах тоже переводим в латиницу
  function fixModel(model) {
    const words = model.split(" ");
    if (!/^[A-Z0-9-]+$/i.test(words[0] || "")) return model;
    const map = { ...CYR2LAT, б: "6", З: "3", з: "3", О: "O", о: "o", а: "a", е: "e", с: "c",
                  р: "p", х: "x", у: "y", к: "k", м: "m", т: "t", н: "h", в: "b" };
    return words.map((w) => (/[А-Яа-яЁё]/.test(w) ? w.replace(/[А-Яа-яЁё]/g, (c) => map[c] || c) : w))
      .join(" ").toUpperCase();
  }

  const BRANDS = ["LADA", "ВАЗ", "УАЗ", "ГАЗ", "КАМАЗ", "KAMAZ", "KIA", "HYUNDAI", "GENESIS", "TOYOTA",
    "LEXUS", "NISSAN", "INFINITI", "DATSUN", "MITSUBISHI", "MAZDA", "HONDA", "SUBARU", "SUZUKI",
    "VOLKSWAGEN", "SKODA", "AUDI", "PORSCHE", "BMW", "MINI", "MERCEDES-BENZ", "MERCEDES", "RENAULT",
    "PEUGEOT", "CITROEN", "OPEL", "FORD", "CHEVROLET", "CADILLAC", "JEEP", "DODGE", "VOLVO",
    "LAND ROVER", "RANGE ROVER", "JAGUAR", "FIAT", "TESLA", "DAEWOO", "RAVON", "HAVAL", "GREAT WALL",
    "TANK", "CHERY", "CHERYEXEED", "EXEED", "OMODA", "JAECOO", "GEELY", "CHANGAN", "JETOUR", "BYD",
    "ZEEKR", "VOYAH", "HONGQI", "LIXIANG", "LI AUTO", "FAW", "JAC", "DONGFENG", "GAC", "BELGEE",
    "SOLARIS", "MOSKVICH", "МОСКВИЧ", "SSANGYONG", "KGM"];

  function findModelByBrand(ls) {
    for (const l of ls) {
      if (/VIN|Идентиф/i.test(l)) continue;
      const up = l.toUpperCase();
      const lat = toLatin(up);
      for (const b of BRANDS) {
        const isCyr = /[А-Я]/.test(b);
        const hay = isCyr ? up : lat;
        const re = new RegExp(`(?:^|[^A-ZА-Я])(${b.replace(/[-]/g, "\\-")})(?![A-ZА-Я])`);
        const m = hay.match(re);
        if (m) return clean(l.slice(m.index + m[0].indexOf(m[1])));
      }
    }
    return "";
  }

  function findPlate(text) {
    const L = `[${PLATE_LETTERS}]`;
    const m = text.toUpperCase().match(new RegExp(`(${L})\\s?(\\d{3})\\s?(${L})\\s?(${L})\\s?(\\d{2,3})(?!\\d)`));
    if (!m) return "";
    const cyr = (c) => LAT2CYR[c] || c;
    return cyr(m[1]) + m[2] + cyr(m[3]) + cyr(m[4]) + m[5];
  }

  const YEAR_RE = /(?<!\d)(19[5-9]\d|20[0-3]\d)(?!\d)/;

  function findYear(ls, withFallback) {
    const m = (after(ls, "годвыпуска") || "").match(YEAR_RE);
    if (m) return m[1];
    if (!withFallback) return "";
    // запасной способ: отдельное четырёхзначное число в разумных годах, не масса и не мощность
    for (const l of ls) {
      if (/мас|кг|мощ|квт|л\.?\s*с|объ[её]м|VIN|Идентиф/i.test(l)) continue;
      const y = l.match(YEAR_RE);
      if (y) return y[1];
    }
    return "";
  }

  function findSts(text) {
    // распознаватель иногда вставляет дефис или точку между группами: «99 50-123456»
    const m = text.match(/(?<!\d)(\d{2})[\s.-]*(\d{2})[\s.-]*(\d{6})(?![\d])/);
    return m ? `${m[1]} ${m[2]} ${m[3]}` : "";
  }

  function paperPts(v) {
    const paper = toCyr(v || "").toUpperCase().match(/(?<!\d)(\d{2})\s?([А-Я]{2})\s?(\d{6})(?!\d)/);
    return paper ? { pts_kind: "paper", pts: `${paper[1]} ${paper[2]} ${paper[3]}` } : null;
  }

  function findPts(ls) {
    const v = after(ls, "паспорттс");
    const epts = (v || "").replace(/\s/g, "").match(/(?<!\d)\d{15}(?!\d)/);
    if (epts) return { pts_kind: "epts", pts: epts[0] };
    if (paperPts(v)) return paperPts(v);
    // запасной способ: 15 цифр подряд или «77 УХ 123456» в любой строке
    for (const l of ls) {
      const e = l.replace(/\s/g, "").match(/(?<!\d)\d{15}(?!\d)/);
      if (e) return { pts_kind: "epts", pts: e[0] };
    }
    for (const l of ls) {
      if (/знак|номер|VIN/i.test(l)) continue;
      if (paperPts(l)) return paperPts(l);
    }
    return {};
  }

  const clean = (s) => (s || "").replace(/[|_«»"]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

  const isAbsent = (s) => fuzzyEnd(toCyr(s || "").replace(/[^а-я]/g, ""), "отсутствует", 3) >= 0;

  // Допускаем только: «ОТСУТСТВУЕТ», полный VIN (17) или японский номер кузова с дефисом.
  // Обрывок вроде «WAUZZZ8V5» лучше оставить пустым, чем вписать в договор неверно.
  function bodyOrChassis(v) {
    const t = clean(v);
    if (!t) return "";
    if (isAbsent(t)) return "ОТСУТСТВУЕТ";
    const s = toLatin(t).replace(/\s/g, "").replace(/O/g, "0");
    const vin = s.match(/(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/);
    if (vin) return vin[0];
    const frame = s.match(/(?<![A-Z0-9])[A-Z0-9]{2,8}-[0-9]{5,8}(?![0-9])/);
    return frame ? frame[0] : "";
  }

  const COLOR_RE = /(?:^|[^а-я])((?:темно|тёмно|светло)-?)?(бел|ч[её]рн|сер|серебрист|син|красн|зел[её]н|коричнев|бежев|ж[её]лт|оранжев|фиолетов|голуб|бордов|золотист|вишн[её]в|бирюзов|графитов|перламутров)(ый|ой|ий)(?![а-я])/;

  function findColor(ls) {
    const byLabel = clean(after(ls, "цвет")).replace(/[^А-Яа-яЁёA-Za-z -]/g, "").trim();
    const m1 = toCyr(byLabel).match(COLOR_RE);
    if (m1) return (m1[1] || "") + m1[2] + m1[3];
    for (const l of ls) {
      const m = toCyr(l).match(COLOR_RE);
      if (m) return (m[1] || "") + m[2] + m[3];
    }
    return "";
  }

  function findType(ls) {
    const byLabel = clean(after(ls, "типтс")).replace(/^[^А-Яа-яA-Za-z]+/, "");
    if (/легков|грузов|автобус|мото|прицеп|спец/i.test(toCyr(byLabel))) return byLabel;
    for (const l of ls) {
      const m = toCyr(l).match(/(легков\S*(?:\s+[а-я]+)?)/);
      if (m) return m[1].toUpperCase();
    }
    return byLabel.length <= 30 ? byLabel : "";
  }

  function parseSts(text) {
    const ls = lines(text);
    const out = {};
    const vin = findVin(ls);
    if (vin) out.vin = vin;
    const plate = findPlate(text);
    if (plate) out.plate = plate;

    // подписи, найденные с допуском на ошибки
    let model = fixModel(clean(after(ls, "маркамодель")));
    if (!/[A-ZА-Я]{2}/i.test(model)) model = "";
    const year = findYear(ls, !!vin);
    let type = findType(ls);
    const cat = (after(ls, "категория", 1).toUpperCase()
      .match(/(?:^|\s)([ABCDEАВСДЕ])(?:\s|$)/) || [])[1];
    let catLat = cat ? toLatin(cat).replace("Д", "D") : "";
    let color = "";
    let body = bodyOrChassis(after(ls, "кузов"));
    let chassis = bodyOrChassis(after(ls, "шасси"));

    // Запасные способы только для стороны с данными машины (на ней есть VIN).
    // На обороте с владельцем они не работают, чтобы не цеплять слова из адреса.
    if (vin) {
      if (!model) model = fixModel(findModelByBrand(ls));
      color = findColor(ls);
      if (!body && countVin(ls, vin) >= 2) body = vin;          // в СТС кузов обычно равен VIN
      if (!chassis && ls.some(isAbsent) && body !== "ОТСУТСТВУЕТ") chassis = "ОТСУТСТВУЕТ";
      if (!catLat && /легков/i.test(toCyr(type))) catLat = "B";
      Object.assign(out, findPts(ls));
    } else {
      const v = after(ls, "цвет");
      const m = toCyr(v).match(COLOR_RE);
      if (m) color = (m[1] || "") + m[2] + m[3];
      type = /легков|грузов/i.test(toCyr(type)) ? type : "";
    }

    if (model) out.model = model;
    if (year) out.year = year;
    if (type || catLat) out.category = [type, catLat].filter(Boolean).join(", ");
    if (color) out.color = color.toLowerCase();
    if (body) out.body = body;
    if (chassis) out.chassis = chassis;
    const sts = findSts(text);
    if (sts) out.sts = sts;
    return out;
  }

  // Слияние двух проходов распознавания: второй только дополняет пустые поля первого
  function merge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (!out[k] && v) out[k] = v;
    return out;
  }

  const api = { parseSts, merge, ALLOWED: ["vin", "plate", "model", "year", "category", "color", "body",
                                           "chassis", "pts_kind", "pts", "sts"] };
  if (typeof module !== "undefined") module.exports = api;
  else root.StsParse = api;
})(this);
