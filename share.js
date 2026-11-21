// The share window: a picture card of the run (pet, plane, score, a QR code with the challenge
// link), with buttons to save it, copy the link or hand it to the phone's own share sheet.
// game.js downloads this file only when Share is first tapped, so the game itself stays small.
// Plain old JavaScript (no arrows, no classes), like game.js, so older phones can read it.
(function (root) {
"use strict";

// -------------------------
// QR codes, written here so nothing has to be downloaded: byte mode, error correction level M,
// versions 1 to 6 (up to 106 bytes, plenty for a challenge link). ISO/IEC 18004.
// -------------------------
// Per version (1-6) at level M: [blocks, data codewords per block, error correction codewords per block].
var QR_M_BLOCKS = [null, [1, 16, 10], [1, 28, 16], [1, 44, 26], [2, 32, 18], [2, 43, 24], [4, 27, 16]];
var QR_ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// Arithmetic in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
var GF_EXP = [], GF_LOG = [];
(function () {
    var value = 1;
    for (var i = 0; i < 255; i++) {
        GF_EXP[i] = value;
        GF_LOG[value] = i;
        value <<= 1;
        if (value & 256) value ^= 0x11D;
    }
    for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMultiply(a, b) {
    return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
}

function rsGenerator(degree) {
    // (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power first.
    var poly = [1];
    for (var i = 0; i < degree; i++) {
        var next = [];
        for (var j = 0; j <= poly.length; j++) {
            next[j] = (j < poly.length ? poly[j] : 0) ^ (j > 0 ? gfMultiply(poly[j - 1], GF_EXP[i]) : 0);
        }
        poly = next;
    }
    return poly;
}

function rsEncode(data, degree) {
    // The error correction codewords: the remainder of data * x^degree divided by the generator.
    var generator = rsGenerator(degree), rest = data.slice();
    for (var i = 0; i < degree; i++) rest.push(0);
    for (i = 0; i < data.length; i++) {
        var factor = rest[i];
        if (!factor) continue;
        for (var j = 0; j < generator.length; j++) rest[i + j] ^= gfMultiply(generator[j], factor);
    }
    return rest.slice(data.length);
}

function utf8Bytes(text) {
    var bytes = [], plain = unescape(encodeURIComponent(text));
    for (var i = 0; i < plain.length; i++) bytes.push(plain.charCodeAt(i));
    return bytes;
}

function qrFormatBits(mask) {
    // Level M is 00; then the mask number, a BCH(15,5) check and the fixed 0x5412 pattern.
    var data = mask, rest = data;
    for (var i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
    return ((data << 10) | rest) ^ 0x5412;
}

function qrMaskHit(mask, row, column) {
    switch (mask) {
        case 0: return (row + column) % 2 === 0;
        case 1: return row % 2 === 0;
        case 2: return column % 3 === 0;
        case 3: return (row + column) % 3 === 0;
        case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
        case 5: return row * column % 2 + row * column % 3 === 0;
        case 6: return (row * column % 2 + row * column % 3) % 2 === 0;
        default: return ((row + column) % 2 + row * column % 3) % 2 === 0;
    }
}

function makeQrCodewords(bytes, version) {
    // Mode, length, the bytes, a terminator and padding, split into blocks, each with its own
    // error correction, and then woven together column by column.
    var spec = QR_M_BLOCKS[version], blocks = spec[0], perBlock = spec[1], ecPerBlock = spec[2];
    var capacity = blocks * perBlock * 8, bits = [];
    function put(value, length) { for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    put(4, 4);
    put(bytes.length, 8);
    bytes.forEach(function (byte) { put(byte, 8); });
    put(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
        var byte = 0;
        for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        data.push(byte);
    }
    for (var pad = 0; data.length < blocks * perBlock; pad++) data.push(pad % 2 ? 0x11 : 0xEC);
    var dataBlocks = [], ecBlocks = [];
    for (i = 0; i < blocks; i++) {
        var block = data.slice(i * perBlock, (i + 1) * perBlock);
        dataBlocks.push(block);
        ecBlocks.push(rsEncode(block, ecPerBlock));
    }
    var woven = [];
    for (i = 0; i < perBlock; i++) dataBlocks.forEach(function (block) { woven.push(block[i]); });
    for (i = 0; i < ecPerBlock; i++) ecBlocks.forEach(function (block) { woven.push(block[i]); });
    return woven;
}

function makeQrBase(version) {
    // The fixed parts: finders, separators, timing lines, alignment patterns and the dark module.
    // `fixed` marks every module data must not use (including the format areas).
    var size = 17 + 4 * version, modules = [], fixed = [];
    for (var row = 0; row < size; row++) {
        modules.push([]);
        fixed.push([]);
        for (var column = 0; column < size; column++) { modules[row].push(false); fixed[row].push(false); }
    }
    function set(row, column, dark) {
        if (row < 0 || column < 0 || row >= size || column >= size) return;
        modules[row][column] = dark;
        fixed[row][column] = true;
    }
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (corner) {
        for (var dy = -1; dy <= 7; dy++) {
            for (var dx = -1; dx <= 7; dx++) {
                var ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
                set(corner[0] + dy, corner[1] + dx, ring !== 2 && ring <= 3);
            }
        }
    });
    for (var i = 8; i < size - 8; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }
    var centers = QR_ALIGNMENT[version];
    centers.forEach(function (cy) {
        centers.forEach(function (cx) {
            if ((cy === 6 && cx === 6) || (cy === 6 && cx === size - 7) || (cy === size - 7 && cx === 6)) return;
            for (var dy = -2; dy <= 2; dy++) {
                for (var dx = -2; dx <= 2; dx++) set(cy + dy, cx + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
            }
        });
    });
    placeQrFormat(modules, fixed, 0);  // Reserves the format areas; the real bits come later.
    set(size - 8, 8, true);
    return {size: size, modules: modules, fixed: fixed};
}

function placeQrFormat(modules, fixed, mask) {
    var size = modules.length, bits = qrFormatBits(mask);
    function set(row, column, index) {
        modules[row][column] = ((bits >>> index) & 1) === 1;
        fixed[row][column] = true;
    }
    // Around the top left finder...
    for (var i = 0; i <= 5; i++) set(i, 8, i);
    set(7, 8, 6);
    set(8, 8, 7);
    set(8, 7, 8);
    for (i = 9; i < 15; i++) set(8, 14 - i, i);
    // ...and split between the other two.
    for (i = 0; i < 8; i++) set(8, size - 1 - i, i);
    for (i = 8; i < 15; i++) set(size - 15 + i, 8, i);
    modules[size - 8][8] = true;  // The dark module, always dark.
}

function placeQrData(base, codewords) {
    // Two columns at a time from the bottom right, snaking up and down, skipping column 6.
    var size = base.size, modules = base.modules.map(function (line) { return line.slice(); }), bit = 0;
    var total = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        var upward = ((right + 1) & 2) === 0;
        for (var step = 0; step < size; step++) {
            var row = upward ? size - 1 - step : step;
            for (var j = 0; j < 2; j++) {
                var column = right - j;
                if (base.fixed[row][column]) continue;
                // Leftover modules after the last codeword (the remainder bits) stay light.
                modules[row][column] = bit < total && ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
                bit += 1;
            }
        }
    }
    return modules;
}

function qrPenalty(modules) {
    // The standard's four rules: long runs, 2x2 blocks, finder look-alikes, and dark/light balance.
    var size = modules.length, score = 0, dark = 0, row, column;
    function line(get) {
        var points = 0, run = 1;
        for (var i = 1; i <= size; i++) {
            if (i < size && get(i) === get(i - 1)) { run += 1; continue; }
            if (run >= 5) points += run - 2;
            run = 1;
        }
        // A finder look-alike: dark light dark dark dark light dark with four light on one side.
        for (i = 0; i + 7 <= size; i++) {
            if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)) {
                var before = true, after = true;
                for (var k = 1; k <= 4; k++) {
                    if (i - k >= 0 && get(i - k)) before = false;
                    if (i + 6 + k < size && get(i + 6 + k)) after = false;
                }
                if (before || after) points += 40;
            }
        }
        return points;
    }
    for (row = 0; row < size; row++) {
        score += line(function (i) { return modules[row][i]; });
        score += line(function (i) { return modules[i][row]; });
    }
    for (row = 0; row < size; row++) {
        for (column = 0; column < size; column++) {
            if (modules[row][column]) dark += 1;
            if (row + 1 < size && column + 1 < size) {
                var color = modules[row][column];
                if (modules[row][column + 1] === color && modules[row + 1][column] === color &&
                    modules[row + 1][column + 1] === color) score += 3;
            }
        }
    }
    score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return score;
}

function makeQr(text, forcedMask) {
    // Returns {version, mask, size, modules: rows of true (dark) / false}, or null when too long.
    var bytes = utf8Bytes(text);
    var version = 1;
    while (version <= 6 && 4 + 8 + bytes.length * 8 > QR_M_BLOCKS[version][0] * QR_M_BLOCKS[version][1] * 8) version += 1;
    if (version > 6) return null;
    var base = makeQrBase(version), placed = placeQrData(base, makeQrCodewords(bytes, version));
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
        if (forcedMask !== undefined && mask !== forcedMask) continue;
        var modules = placed.map(function (line, row) {
            return line.map(function (dark, column) {
                return base.fixed[row][column] ? dark : dark !== qrMaskHit(mask, row, column);
            });
        });
        placeQrFormat(modules, base.fixed.map(function (line) { return line.slice(); }), mask);
        var penalty = qrPenalty(modules);
        if (best === null || penalty < best.penalty) {
            best = {version: version, mask: mask, size: base.size, modules: modules, penalty: penalty};
        }
    }
    return best;
}

// -------------------------
// The card: a 900 x 1200 picture in the game's own pixel style. All the art (scenery, pillars,
// plane, trail) shares one pixel size, UNIT card pixels to one game pixel; words use whole sizes.
// -------------------------
var CARD_WIDTH = 900, CARD_HEIGHT = 1200, UNIT = 5;
var WHITE = [255, 255, 255];
var RIM = [246, 226, 181], TICKET = [255, 247, 228];  // A warmer rim, so the ticket stands out on it.
var SKY = {x: 32, y: 96, w: 167 * UNIT, h: 108 * UNIT};
var TICKET_BOX = {x: 32, y: 664, w: 836, h: 504};

function css(color, alpha) {
    return "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + (alpha === undefined ? 1 : alpha) + ")";
}

function box(pen, x, y, w, h, color, alpha) {
    pen.fillStyle = css(color, alpha);
    pen.fillRect(x, y, w, h);
}

function stepped(pen, x, y, w, h, color, corner, alpha) {
    // A block with its corners cut in steps of `corner` pixels, like the game's pixel panels.
    box(pen, x + corner, y, w - 2 * corner, h, color, alpha);
    box(pen, x, y + corner, w, h - 2 * corner, color, alpha);
}

function plate(pen, x, y, w, h, fill, ink, shadow) {
    // A pixel panel: a two-unit dark edge with one-unit steps at the corners.
    if (shadow) stepped(pen, x + shadow, y + shadow, w, h, ink, UNIT, 0.35);
    stepped(pen, x, y, w, h, ink, UNIT);
    stepped(pen, x + 2 * UNIT, y + 2 * UNIT, w - 4 * UNIT, h - 4 * UNIT, fill, UNIT);
}

function putText(pen, kit, text, scale, color, centerX, centerY, outline) {
    var label = kit.text(String(text), scale, color, outline || null);
    pen.imageSmoothingEnabled = false;
    pen.drawImage(label, Math.round(centerX - label.width / 2), Math.round(centerY - label.height / 2));
    return label;
}

function wrapWords(kit, text, scale, width) {
    // Lines that fit `width` at this one size. English breaks between words; Chinese between
    // characters, but a number stays whole and punctuation never starts a line.
    var english = !/[㐀-鿿]/.test(text);
    var pieces = english ? text.split(" ") : text.match(/[0-9]+|./g), joiner = english ? " " : "";
    var lines = [""];
    pieces.forEach(function (piece) {
        var last = lines[lines.length - 1], longer = last ? last + joiner + piece : piece;
        if (!last || "，。！？、".indexOf(piece) >= 0 || kit.text(longer, scale, [0, 0, 0], null).width <= width) {
            lines[lines.length - 1] = longer;
        } else {
            lines.push(piece === " " ? "" : piece);
        }
    });
    return lines.map(function (line) { return line.trim(); });
}

function mix(a, b, share) {
    return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * share); });
}

function drawScene(pen, kit) {
    // A little piece of the flying world, drawn at game size in the first sky's own colours and
    // then enlarged UNIT times with hard edges: banded sky, the sun, clouds, hills, a tree line,
    // a strip of grass, and a pillar standing at the right like the ones the pet flies between.
    var w = SKY.w / UNIT, h = SKY.h / UNIT, theme = kit.theme;
    var world = document.createElement("canvas");
    world.width = w;
    world.height = h;
    var p = world.getContext("2d");
    p.imageSmoothingEnabled = false;
    function rect(color, x, y, rw, rh) { box(p, x, y, rw, rh, color); }
    // Sky: bands six pixels tall, from the top colour through the middle to the warm horizon.
    for (var y = 0; y < h; y += 6) {
        var share = Math.min(1, y / 96);
        rect(share < .5 ? mix(theme.sky[0], theme.sky[1], share * 2) : mix(theme.sky[1], theme.sky[2], share * 2 - 1), 0, y, w, 6);
    }
    // The sun with a soft ring, in steps.
    var sunX = 132, sunY = 24;
    [[16, mix(theme.body, theme.sky[1], .65)], [12, theme.body]].forEach(function (ring) {
        var r = ring[0];
        for (var dy = -r; dy <= r; dy++) {
            var half = Math.round(Math.sqrt(r * r - dy * dy));
            rect(ring[1], sunX - half, sunY + dy, half * 2, 1);
        }
    });
    // Two blocky clouds.
    [[18, 20, 1], [104, 46, .8]].forEach(function (cloud) {
        var x = cloud[0], top = cloud[1];
        rect(theme.cloud, x + 6, top, 12, 3);
        rect(theme.cloud, x + 2, top + 3, 24, 3);
        rect(theme.cloud, x, top + 6, 34, 4);
    });
    // Far hills, then a row of pointed trees, then the grass.
    var hills = [86, 84, 80, 78, 78, 80, 84, 82, 76, 72, 70, 72, 76, 80, 82, 80, 76, 74, 76, 80, 84, 86];
    hills.forEach(function (top, i) { rect(theme.far, i * 8, top, 8, h - top); });
    for (var x = -4; x < w; x += 11) {
        var tall = 12 + (x * 7 % 9), base = 102;
        for (var row = 0; row < tall; row += 2) {
            var half = Math.floor(row / 3) + 1;
            rect(theme.tree, x + 5 - half, base - tall + row, half * 2, 2);
        }
    }
    rect(theme.near, 0, 98, w, 6);
    rect(theme.ground, 0, 104, w, h - 104);
    rect(mix(theme.ground, [255, 255, 255], .25), 0, 104, w, 1);
    [[12, 105], [40, 106], [77, 105], [118, 106]].forEach(function (flower, i) {
        rect(i % 2 ? [255, 200, 62] : [240, 140, 160], flower[0], flower[1], 2, 2);
    });
    // One pillar, standing at the right (a stub of one at the top left read as a glitch).
    p.drawImage(kit.pillar(44, 60, false), w - 24, h - 56);
    pen.imageSmoothingEnabled = false;
    pen.drawImage(world, 0, 0, w, h, SKY.x, SKY.y, SKY.w, SKY.h);
}

function drawPlane(pen, kit) {
    // The player's pet in the plane in use, level and at the same pixel size as the world, with
    // the trail in use streaming behind it and fading in from the window's left edge.
    var plane = kit.plane(UNIT), size = plane.size * UNIT;
    var left = SKY.x + Math.round(SKY.w * 0.56) - size / 2, top = SKY.y + 366 - size / 2;
    var trail = document.createElement("canvas");
    trail.width = SKY.w;
    trail.height = SKY.h;
    var trailPen = trail.getContext("2d");
    kit.drawTrail(trailPen, UNIT, left - SKY.x, top - SKY.y, kit.score);
    trailPen.globalCompositeOperation = "destination-out";
    for (var x = 0; x < 40; x += UNIT) {  // Fading in, one pixel column at a time.
        box(trailPen, x, 0, UNIT, SKY.h, [0, 0, 0], 1 - x / 40);
    }
    pen.drawImage(trail, SKY.x, SKY.y);
    pen.imageSmoothingEnabled = false;
    pen.drawImage(plane.picture, left, top, size, size);
}

function drawQr(pen, qr, x, y, size, ink) {
    // Dark squares on white, whole card pixels each, with the standard's four-module quiet edge.
    var modules = qr.size + 8, cell = Math.floor(size / modules);
    var left = x + Math.floor((size - cell * modules) / 2), top = y + Math.floor((size - cell * modules) / 2);
    box(pen, x, y, size, size, WHITE);
    for (var row = 0; row < qr.size; row++) {
        for (var column = 0; column < qr.size; column++) {
            if (qr.modules[row][column]) box(pen, left + (column + 4) * cell, top + (row + 4) * cell, cell, cell, ink);
        }
    }
    return cell;
}

function getCardWords(kit) {
    // A playful line for how far the pet got, and a short dare.
    var words = kit.words, n = kit.score, name = kit.name;
    var who = name === null ? words("我", "I") : name;
    if (n < 1) return {fun: words(who + "起飞啦，下次飞更远！", who + " just took off!"), dare: words("一起来飞吧！", "Fly with me!")};
    var fun;
    if (n < 10) fun = words(who + "刚学会起飞，越飞越带劲", who + " got off the ground!");
    else if (n < 30) fun = words(who + "稳稳穿过 " + n + " 根柱子", who + " cruised past " + n + " pillars");
    else if (n < 80) fun = words(who + "一口气穿过 " + n + " 根柱子，毛都没乱", who + " threaded " + n + " pillars, fur perfect");
    else fun = words("传说级！" + who + "连过 " + n + " 根柱子", "Legend! " + who + " flew past " + n + " pillars");
    return {fun: fun, dare: words("你能超过我吗？", "Can you beat me?")};
}

function drawWordmark(pen, kit, centerY) {
    // The game's name along the top, at size 3 so it still reads when the card is small,
    // with 二宝 in her flying helmet from the logo in front of it.
    // The English and Chinese are drawn apart: English letters only get their bold strokes on
    // their own.
    var c = kit.colors, parts = ["FLUFFY PILOTS", "·", "飞行搭档"].map(function (part) { return kit.text(part, 3, c.ink, null); });
    var head = kit.head, headH = 56, headW = head ? Math.round(head.naturalWidth * headH / head.naturalHeight) : 0;
    var gap = 14, width = headW + (head ? gap : 0) - gap;
    parts.forEach(function (part) { width += gap + part.width; });
    var x = Math.round((CARD_WIDTH - width) / 2);
    if (head) {
        pen.imageSmoothingEnabled = true;  // A photo, like the home page's logo draws her.
        pen.drawImage(head, x, Math.round(centerY - headH / 2), headW, headH);
        pen.imageSmoothingEnabled = false;
        x += headW + gap;
    }
    parts.forEach(function (part) {
        pen.drawImage(part, x, Math.round(centerY - part.height / 2));
        x += part.width + gap;
    });
}

function drawCard(kit) {
    var card = document.createElement("canvas");
    card.width = CARD_WIDTH;
    card.height = CARD_HEIGHT;
    var pen = card.getContext("2d"), c = kit.colors;
    pen.imageSmoothingEnabled = false;
    // A dark frame with stepped corners and a warm rim; the game's name, small, along the top.
    stepped(pen, 0, 0, CARD_WIDTH, CARD_HEIGHT, c.ink, 3 * UNIT);
    stepped(pen, 2 * UNIT, 2 * UNIT, CARD_WIDTH - 4 * UNIT, CARD_HEIGHT - 4 * UNIT, RIM, 2 * UNIT);
    drawWordmark(pen, kit, SKY.y / 2 + 6);

    // The sky window, with the pet and its plane as the hero in the middle.
    box(pen, SKY.x - UNIT, SKY.y - UNIT, SKY.w + 2 * UNIT, SKY.h + 2 * UNIT, c.ink);
    pen.save();
    pen.beginPath();
    pen.rect(SKY.x, SKY.y, SKY.w, SKY.h);
    pen.clip();
    drawScene(pen, kit);
    drawPlane(pen, kit);
    pen.restore();

    // The ticket under it: the score, a line about the flight and the dare; the QR code beside.
    var t = TICKET_BOX, words = getCardWords(kit);
    plate(pen, t.x, t.y, t.w, t.h, TICKET, c.ink, 2 * UNIT);
    var inner = {x: t.x + 2 * UNIT, y: t.y + 2 * UNIT, w: t.w - 4 * UNIT, h: t.h - 4 * UNIT};
    var qr = makeQr(kit.link), qrSize = 216, qrX = inner.x + inner.w - 28 - qrSize;
    var caption = kit.text(kit.words("扫码来挑战", "Scan me!"), 3, c.forest, null);
    var qrY = inner.y + Math.round((inner.h - qrSize - 20 - caption.height) / 2);
    if (qr) {
        box(pen, qrX - UNIT, qrY - UNIT, qrSize + 2 * UNIT, qrSize + 2 * UNIT, c.ink);
        drawQr(pen, qr, qrX, qrY, qrSize, c.ink);
        putText(pen, kit, kit.words("扫码来挑战", "Scan me!"), 3, c.forest, qrX + qrSize / 2, qrY + qrSize + 20 + caption.height / 2);
    }
    var left = inner.x + 28, right = qrX - 2 * UNIT - 32, middle = Math.round((left + right) / 2);
    // From the bottom up: the dare on a sun-yellow plate, the line, then the score in the room left.
    var dare = kit.text(words.dare, 3, c.ink, null);
    var plateH = dare.height + 2 * 14 + 4 * UNIT, plateW = dare.width + 2 * 28 + 4 * UNIT;
    var plateY = inner.y + inner.h - 26 - plateH;
    plate(pen, Math.round(middle - plateW / 2), plateY, plateW, plateH, c.sun, c.ink, UNIT);
    putText(pen, kit, words.dare, 3, c.ink, middle, plateY + plateH / 2);
    var lines = wrapWords(kit, words.fun, 3, right - left).slice(0, 2), lineHeight = 56;
    var lineTop = plateY - 24 - lines.length * lineHeight;
    lines.forEach(function (line, number) {
        putText(pen, kit, line, 3, c.ink, middle, lineTop + number * lineHeight + lineHeight / 2);
    });
    // The score, as big as the room above the line allows: it must read on a small thumbnail.
    // The digits fill about three quarters of the picture's height; the rest is empty space.
    var scale = 15, room = lineTop - inner.y - 24;
    while (scale > 8) {
        var number = kit.text(String(kit.score), scale, c.red, c.ink);
        if (number.width <= right - left && number.height * 0.75 <= room - 40) break;
        scale -= 1;
    }
    putText(pen, kit, kit.score, scale, c.red, middle, Math.round((inner.y + 12 + lineTop) / 2), c.ink);
    return card;
}

// -------------------------
// The window over the game
// -------------------------
var EDGE = "0 -4px 0 #342014,0 4px 0 #342014,-4px 0 0 #342014,4px 0 0 #342014";
var STYLE = [
    ".share-shade{position:fixed;top:0;right:0;bottom:0;left:0;z-index:30;display:flex;align-items:center;justify-content:center;",
    "box-sizing:border-box;padding:28px;background:rgba(28,22,18,.72);-webkit-user-select:none;user-select:none;touch-action:manipulation}",
    ".share-box{position:relative;display:flex;align-items:center;gap:24px;box-sizing:border-box;padding:16px;",
    "background:#fff1d0;box-shadow:" + EDGE + ",8px 10px 0 rgba(52,32,20,.47)}",
    ".share-box.tall{flex-direction:column;gap:14px}",
    ".share-card{display:block;flex:none;-webkit-touch-callout:default;-webkit-user-select:auto;user-select:auto;",
    "pointer-events:auto;box-shadow:0 0 0 3px #342014}",
    // In WeChat the card itself is what to press: a sun-yellow outline marks it, and it pulses
    // when the words beside it are tapped.
    ".share-card.hold{box-shadow:0 0 0 3px #342014,0 0 0 9px #ffc83e,0 0 0 12px #342014}",
    ".share-card.pulse{animation:share-pulse .5s steps(4) 2}",
    "@keyframes share-pulse{50%{box-shadow:0 0 0 3px #342014,0 0 0 15px #ffc83e,0 0 0 18px #342014}}",
    ".share-side{display:flex;flex-direction:column;align-items:stretch;gap:14px;width:300px;color:#342014;text-align:center}",
    ".share-box.tall .share-side{width:auto;max-width:340px}",
    ".share-title{margin:0;font-size:24px;line-height:1.25;color:#9e1c2c;text-wrap:balance}",
    ".share-tip{margin:0;font-size:16px;line-height:1.5;color:#342014;text-wrap:balance}",
    ".share-button{display:block;margin:4px;border:0;padding:10px 14px;font-size:24px;line-height:1.1;color:#342014;",
    "background:#fff1d0;cursor:pointer;white-space:nowrap;box-shadow:" + EDGE + ",6px 8px 0 rgba(52,32,20,.47)}",
    ".share-button:active{transform:translate(2px,3px);box-shadow:" + EDGE + "}",
    ".share-button.main{background:#ffc83e}",
    ".share-button:hover{background:#f7d69e}.share-button.main:hover{background:#ffd866}",
    ".share-button.done,.share-button.done:hover{background:#488a42;color:#fff1d0}",
    ".share-hold{display:flex;align-items:center;justify-content:center;gap:10px;margin:4px;padding:6px 4px;",
    "font-size:24px;line-height:1.25;color:#342014;cursor:pointer}",
    ".share-hold svg{width:24px;height:24px;flex:none;shape-rendering:crispEdges}",
    ".share-box.tall .share-hold svg{transform:rotate(90deg)}",
    ".share-link{display:none;box-sizing:border-box;width:calc(100% - 8px);margin:4px;border:0;padding:8px 10px;font:inherit;font-size:16px;",
    "color:#342014;background:#fff;box-shadow:" + EDGE + ";-webkit-user-select:text;user-select:text;text-overflow:ellipsis}",
    ".share-link.shown{display:block}",
    ".share-note{margin:0 auto;padding:4px 12px;font-size:16px;line-height:1.5;color:#fff1d0;background:#488a42;visibility:hidden}",
    ".share-note.shown{visibility:visible}",
    ".share-close{position:absolute;top:-16px;right:-16px;width:44px;height:44px;border:0;padding:0;cursor:pointer;",
    "background:#e23434;box-shadow:" + EDGE + "}",
    ".share-close svg{display:block;width:20px;height:20px;margin:auto;shape-rendering:crispEdges}",
    ".share-shade.share-small{padding:12px}.share-small .share-box{padding:10px;gap:16px}",
    ".share-small .share-side{gap:8px}.share-small .share-button,.share-small .share-hold{padding:7px 10px}",
    ".share-small .share-title,.share-box.tall .share-title{display:none}",
    ".share-small .share-close{top:-8px;right:-8px}",
    // The page's own install card waits while this window is open.
    "html.share-is-open #app-card{display:none!important}"
].join("");

var panel = null, kitNow = null, cardBlob = null, cardUrl = null, noteTimer = null;
var addressBefore = null, focusBefore = null;

function isWeChat() { return /MicroMessenger/i.test(navigator.userAgent || ""); }

function element(tag, className, text) {
    var made = document.createElement(tag);
    if (className) made.className = className;
    if (text) made.textContent = text;
    return made;
}

function layOut() {
    // Card on the left and buttons on the right on a wide screen (a phone on its side, or the
    // turned page of an upright phone); card above the buttons on a tall one.
    if (!panel) return;
    var shade = panel.shade, style = window.getComputedStyle(shade);
    var spaceW = shade.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    var spaceH = shade.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    var wide = spaceW >= spaceH * 1.05, small = wide && spaceH < 480;
    // A small screen (a phone, often the upright one with the game turned) needs the card as
    // big as it can be, since holding a finger on it is how it is saved there: less padding,
    // no title, and the buttons at most 38% of the width.
    shade.className = "share-shade" + (small ? " share-small" : "");
    panel.box.className = "share-box" + (wide ? "" : " tall") + (small ? " share-small" : "");
    style = window.getComputedStyle(shade);
    spaceW = shade.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    spaceH = shade.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    panel.side.style.width = small ? Math.min(300, Math.floor(spaceW * 0.38)) + "px" : "";
    var sideW = panel.side.offsetWidth || 300, sideH = panel.side.offsetHeight || 260;
    var pad = small ? 20 : 32;
    var height = wide ? Math.min(spaceH - pad, (spaceW - sideW - pad - (small ? 16 : 24)) * 4 / 3)
                      : Math.min(spaceH - sideH - 46, (spaceW - 32) * 4 / 3);
    height = Math.max(120, Math.floor(height));
    panel.card.style.height = height + "px";
    panel.card.style.width = Math.floor(height * 3 / 4) + "px";
}

function showNote(text) {
    panel.note.textContent = text;
    panel.note.className = "share-note shown";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { if (panel) panel.note.className = "share-note"; }, 2600);
}

function copyText(text) {
    // The modern clipboard first; older browsers (and some in-app ones) through a hidden text box.
    function oldWay() {
        var field = element("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
        document.body.appendChild(field);
        field.select();
        try { field.setSelectionRange(0, text.length); } catch (error) {}
        var done = false;
        try { done = document.execCommand("copy"); } catch (error) {}
        document.body.removeChild(field);
        return done;
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return oldWay(); });
    }
    return Promise.resolve(oldWay());
}

function dataUrlToBlob(url) {
    var bytes = atob(url.split(",")[1]), array = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
    return new Blob([array], {type: "image/png"});
}

function getShareFile() {
    if (!cardBlob || typeof File === "undefined") return null;
    try { return new File([cardBlob], "fluffy-pilots-" + kitNow.score + ".png", {type: "image/png"}); } catch (error) { return null; }
}

function canShareFile() {
    // The phone's own share sheet, where it takes pictures (not inside WeChat, which has its own).
    if (isWeChat() || !kitNow || !kitNow.touch) return false;
    var file = getShareFile();
    try { return !!(file && navigator.share && navigator.canShare && navigator.canShare({files: [file]})); } catch (error) { return false; }
}

function shareNatively(withLink) {
    var kit = kitNow, words = getCardWords(kit), file = getShareFile();
    var data = {files: [file]};
    if (withLink) {
        data.title = kit.words("飞行搭档", "Fluffy Pilots");
        data.text = words.fun + " " + words.dare + " " + kit.link;
    }
    navigator.share(data)["catch"](function () {});
}

function savePicture() {
    var kit = kitNow, name = "fluffy-pilots-" + kit.score + ".png";
    kit.track("share_save", {score: kit.score});
    if (canShareFile()) return shareNatively(false);  // The share sheet offers "Save Image".
    var address = cardBlob ? URL.createObjectURL(cardBlob) : cardUrl;
    if (kit.touch) {
        // Phones without a share sheet for pictures: the picture opens by itself, to be held and saved.
        var opened = window.open(address, "_blank");
        showNote(opened ? kit.words("已打开图片，长按保存", "Picture opened: press and hold to save")
                        : kit.words("长按上面的图片保存", "Press and hold the picture to save"));
        return;
    }
    var link = element("a");
    link.download = name;
    link.href = address;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (cardBlob) setTimeout(function () { URL.revokeObjectURL(address); }, 4000);
    showNote(kit.words("图片已保存", "Picture saved"));
}

function copyLink(button) {
    var kit = kitNow, label = button.textContent;
    copyText(kit.link).then(function (done) {
        if (!panel) return;
        if (done) {
            kit.track("share_copy", {score: kit.score});
            button.textContent = kit.words("已复制 ✓", "Copied ✓");
            button.className = "share-button done";
            setTimeout(function () {
                button.textContent = label;
                button.className = "share-button";
            }, 1500);
            return;
        }
        // No clipboard here: the link shows up in its box, selected, ready to copy by hand.
        panel.link.className = "share-link shown";
        layOut();
        panel.link.focus();
        panel.link.select();
        try { panel.link.setSelectionRange(0, kit.link.length); } catch (error) {}
        showNote(kit.words("链接已选中，请手动复制", "Link selected: copy it by hand"));
    });
}

function close() {
    if (!panel) return;
    window.removeEventListener("resize", layOut);
    window.removeEventListener("keydown", onKey, true);
    document.documentElement.classList.remove("share-is-open");
    panel.shade.parentNode.removeChild(panel.shade);
    panel = null;
    // The address keeps the challenge link: people often close this window first and then share
    // from WeChat's own "…" menu. The game puts the old address back when the next run starts
    // (restoreAddress), and never challenges the player with their own link (see game.js).
    if (focusBefore && focusBefore.focus) {
        try { focusBefore.focus(); } catch (error) {}
    }
    focusBefore = null;
    var kit = kitNow;
    kitNow = null;
    if (kit) kit.close();
}

function restoreAddress() {
    if (addressBefore === null) return;
    try { window.history.replaceState(window.history.state, "", addressBefore); } catch (error) {}
    addressBefore = null;
}

function onKey(event) {
    if (event.key === "Escape" || event.key === "Esc") {
        // Heard first (while the event is on its way down) and stopped there, so the game's own
        // Esc (back to the home page) never sees it.
        event.preventDefault();
        event.stopPropagation();
        close();
    }
}

function build(kit) {
    if (!document.getElementById("share-style")) {
        var style = element("style");
        style.id = "share-style";
        style.textContent = STYLE;
        document.head.appendChild(style);
    }
    var words = kit.words;
    var shade = element("div", "share-shade"), box = element("div", "share-box");
    shade.setAttribute("role", "dialog");
    shade.setAttribute("aria-label", words("分享", "Share"));
    var picture = element("img", "share-card");
    picture.alt = words("飞行搭档成绩卡", "Fluffy Pilots score card");
    picture.src = cardUrl;
    var side = element("div", "share-side");
    side.appendChild(element("p", "share-title", words("分享成绩，挑战好友", "Challenge a friend")));
    var buttons = [];
    if (isWeChat()) {
        // WeChat cannot download files, but holding a finger on the picture saves it (and can
        // even open the QR code on it). The card itself gets the yellow outline; beside it, plain
        // words with an arrow say what to do, and a tap on them makes the card pulse.
        picture.className = "share-card hold";
        var hold = element("p", "share-hold");
        hold.innerHTML = '<svg viewBox="0 0 8 8" aria-hidden="true"><path fill="#342014" d="M0 4h1v-1h1v-1h1v-1h1v2h4v2h-4v2h-1v-1h-1v-1h-1z"/></svg>';
        hold.appendChild(element("span", "", words("在图片上长按，保存或发给好友", "Press and hold the picture to save it")));
        hold.addEventListener("click", function () {
            picture.className = "share-card hold";
            void picture.offsetWidth;  // Restarts the pulse.
            picture.className = "share-card hold pulse";
        });
        side.appendChild(hold);
    } else if (canShareFile()) {
        buttons.push(["main", words("分享", "Share"), function () {
            kit.track("share_native", {score: kit.score});
            shareNatively(true);
        }]);
        buttons.push(["", words("保存图片", "Save picture"), savePicture]);
    } else {
        buttons.push(["main", words("保存图片", "Save picture"), savePicture]);
    }
    buttons.push(["", words("复制挑战链接", "Copy challenge link"), copyLink]);
    var first = null;
    buttons.forEach(function (item) {
        var button = element("button", "share-button" + (item[0] ? " " + item[0] : ""), item[1]);
        button.type = "button";
        button.addEventListener("click", function () { item[2](button); });
        side.appendChild(button);
        if (!first) first = button;
    });
    var link = element("input", "share-link");
    link.type = "text";
    link.readOnly = true;
    link.value = kit.link;
    link.setAttribute("aria-label", words("挑战链接", "Challenge link"));
    link.addEventListener("focus", function () { link.select(); });
    side.appendChild(link);
    side.appendChild(element("p", "share-tip", kit.score >= 1
        ? words("好友扫码或打开链接，来挑战你的 " + kit.score + " 分", "Friends who scan or open the link try to beat your " + kit.score + ".")
        : words("好友扫码或打开链接，就能一起来飞", "Friends who scan or open the link can fly too.")));
    var note = element("p", "share-note", "");
    note.setAttribute("aria-live", "polite");
    side.appendChild(note);
    var closer = element("button", "share-close");
    closer.type = "button";
    closer.setAttribute("aria-label", words("关闭", "Close"));
    // A pixel ×, drawn square by square.
    closer.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path fill="#fff1d0" d="M0 0h2v1h1v1h1v1h2v-1h1v-1h1v-1h2v2h-1v1h-1v1h-1v2h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-2v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-2h-1v-1h-1v-1h-1z"/></svg>';
    closer.addEventListener("click", close);
    box.appendChild(picture);
    box.appendChild(side);
    box.appendChild(closer);
    shade.appendChild(box);
    // A tap on the dark shade around the window closes it too; taps inside never reach the game.
    shade.addEventListener("click", function (event) { if (event.target === shade) close(); });
    ["pointerdown", "touchstart", "mousedown", "wheel"].forEach(function (name) {
        shade.addEventListener(name, function (event) { event.stopPropagation(); });
    });
    focusBefore = document.activeElement;
    document.body.appendChild(shade);
    document.documentElement.classList.add("share-is-open");
    panel = {shade: shade, box: box, card: picture, side: side, note: note, link: link};
    window.addEventListener("resize", layOut);
    window.addEventListener("keydown", onKey, true);
    layOut();
    picture.onload = layOut;
    if (first) {
        try { first.focus({preventScroll: true}); } catch (error) { first.focus(); }
    }
    // While the window is open the page's address is the challenge link, so WeChat's own
    // "… → Send to friend / Moments" shares the challenge too, even after this window is closed.
    try {
        if (window.history && window.history.replaceState && kit.link !== window.location.href) {
            if (addressBefore === null) addressBefore = window.location.href;
            window.history.replaceState(window.history.state, "", kit.link);
        }
    } catch (error) { addressBefore = null; }
}

function open(kit) {
    if (panel) close();
    kitNow = kit;
    var tries = 0;
    function draw() {
        // A plane bought in the hangar downloads its picture on first use: wait for it a moment.
        if (!kit.plane(1).ready && tries < 30) {
            tries += 1;
            return setTimeout(draw, 100);
        }
        if (kitNow !== kit) return;
        var card = drawCard(kit);
        cardUrl = card.toDataURL("image/png");
        try { cardBlob = dataUrlToBlob(cardUrl); } catch (error) { cardBlob = null; }
        build(kit);
    }
    draw();
}

root.flightFriendsShare = {
    open: open, close: close, restoreAddress: restoreAddress, drawCard: drawCard, cardWords: getCardWords,
    isOpen: function () { return !!panel; },
    cardUrl: function () { return cardUrl; },
    qr: {make: makeQr, rsEncode: rsEncode, formatBits: qrFormatBits, utf8: utf8Bytes}
};
})(typeof window !== "undefined" ? window : this);
