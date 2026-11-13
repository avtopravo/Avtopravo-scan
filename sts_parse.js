// Разбор текста СТС после распознавания (OCR). Работает в браузере и в Node (для тестов).
// Возвращает ТОЛЬКО поля машины из белого списка. ФИО и адрес владельца сюда не попадают
// никогда: парсер их не ищет, а всё, что не разобрано, остаётся на телефоне.
(function (root) {
  const CYR2LAT = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C",
                    Т: "T", У: "Y", Х: "X" };
  const LAT2CYR = Object.fromEntries(Object.entries(CYR2LAT).map(([c, l]) => [l, c]));
  const PLATE_LETTERS = "АВЕКМНОРСТУХABEKMHOPCTYX";

  const toLatin = (s) => s.toUpperCase().replace(/[АВЕКМНОРСТУХ]/g, (c) => CYR2LAT[c]);

  function lines(text) {
    return text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  // Значение после подписи: на той же строке или на следующей
  function after(ls, label, minLen = 2) {
    for (let i = 0; i < ls.length; i++) {
      const m = ls[i].match(label);
      if (!m) continue;
      const rest = ls[i].slice(m.index + m[0].length).replace(/^[\s:.,№N°-]+/, "").trim();
      if (rest.length >= minLen) return rest;
      if (i + 1 < ls.length) return ls[i + 1];
    }
    return "";
  }

  function findVin(ls) {
    const fix = (s) => toLatin(s).replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL|]/g, "1")
      .replace(/Q/g, "0");
    // VIN это целое «слово» ровно из 17 символов, а не кусок более длинной строки
    // (иначе в VIN попадает обрывок номера ПТС). И в нём обязательно есть и буквы, и цифры.
    const re = /(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/;
    const ok = (v) => /[A-Z]/.test(v) && /\d/.test(v);
    // сначала строка с подписью VIN и следующая за ней, потом остальные, кроме строки ПТС
    const labelled = ls.findIndex((l) => /VIN|Идентиф/i.test(l));
    const order = labelled >= 0 ? [labelled, labelled + 1, ...ls.keys()] : [...ls.keys()];
    for (const i of order) {
      if (i >= ls.length || /Паспорт|СТС|Свидетельство/i.test(ls[i])) continue;
      const cand = fix(ls[i].replace(/.*(VIN|Идентификационный номер)\s*\(?VIN\)?/i, ""));
      const m = cand.match(re);
      if (m && ok(m[0])) return m[0];
    }
    return "";
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

  function findPlate(text) {
    const L = `[${PLATE_LETTERS}]`;
    const m = text.toUpperCase().match(new RegExp(`(${L})\\s?(\\d{3})\\s?(${L})\\s?(${L})\\s?(\\d{2,3})(?!\\d)`));
    if (!m) return "";
    const cyr = (c) => LAT2CYR[c] || c;
    return cyr(m[1]) + m[2] + cyr(m[3]) + cyr(m[4]) + m[5];
  }

  function findYear(ls) {
    const v = after(ls, /Год\s*вып\w*/i);
    const m = (v || "").match(/(19[5-9]\d|20[0-4]\d)/) ;
    return m ? m[1] : "";
  }

  function findSts(text) {
    const m = text.match(/(?<!\d)(\d{2})\s?(\d{2})\s?(\d{6})(?!\d)/);
    return m ? `${m[1]} ${m[2]} ${m[3]}` : "";
  }

  function findPts(ls) {
    const v = after(ls, /Паспорт\s*Т\.?\s*С\.?/i);
    const epts = (v || "").replace(/\s/g, "").match(/\d{15}/);
    if (epts) return { pts_kind: "epts", pts: epts[0] };
    const paper = (v || "").toUpperCase().match(/(\d{2})\s?([А-ЯA-Z]{2})\s?(\d{6})/);
    if (paper) {
      const letters = paper[2].replace(/[ABEKMHOPCTYX]/g, (c) => LAT2CYR[c]);
      return { pts_kind: "paper", pts: `${paper[1]} ${letters} ${paper[3]}` };
    }
    return {};
  }

  const clean = (s) => (s || "").replace(/[|_«»"]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

  // Допускаем только: «ОТСУТСТВУЕТ», полный VIN (17) или японский номер кузова с дефисом.
  // Обрывок вроде «WAUZZZ8V5» лучше оставить пустым, чем вписать в договор неверно.
  function bodyOrChassis(v) {
    const t = clean(v);
    if (/ОТСУТ|ОТСТУТ|OTCYT/i.test(t)) return "ОТСУТСТВУЕТ";
    const s = toLatin(t).replace(/\s/g, "").replace(/O/g, "0");
    const vin = s.match(/(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/);
    if (vin) return vin[0];
    const frame = s.match(/(?<![A-Z0-9])[A-Z0-9]{2,8}-[0-9]{5,8}(?![0-9])/);
    return frame ? frame[0] : "";
  }

  function parseSts(text) {
    const ls = lines(text);
    const out = {};
    const vin = findVin(ls);
    if (vin) out.vin = vin;
    const plate = findPlate(text);
    if (plate) out.plate = plate;
    const model = fixModel(clean(after(ls, /Марка[,.]?\s*модель/i)));
    if (model) out.model = model;
    const year = findYear(ls);
    if (year) out.year = year;
    const type = clean(after(ls, /Тип\s*Т\.?\s*С\.?/i)).replace(/^[^А-Яа-яA-Za-z]+/, "");
    // \b в JS не понимает кириллицу, поэтому границы буквы задаём пробелами
    const cat = (after(ls, /Категория\s*Т\.?\s*С\.?|Категория/i, 1).toUpperCase()
      .match(/(?:^|\s)([ABCDEАВСДЕ])(?:\s|$)/) || [])[1];
    const catLat = cat ? toLatin(cat).replace("Д", "D") : "";
    if (type || catLat) out.category = [type, catLat].filter(Boolean).join(", ");
    const color = clean(after(ls, /Цвет/i)).replace(/[^А-Яа-яЁё -]/g, "").trim();
    if (color) out.color = color.toLowerCase();
    const body = bodyOrChassis(after(ls, /Кузов/i));
    if (body) out.body = body;
    const chassis = bodyOrChassis(after(ls, /Шасси|Рама/i));
    if (chassis) out.chassis = chassis;
    Object.assign(out, findPts(ls));
    const sts = findSts(text);
    if (sts) out.sts = sts;
    return out;
  }

  const api = { parseSts, ALLOWED: ["vin", "plate", "model", "year", "category", "color", "body",
                                    "chassis", "pts_kind", "pts", "sts"] };
  if (typeof module !== "undefined") module.exports = api;
  else root.StsParse = api;
})(this);
