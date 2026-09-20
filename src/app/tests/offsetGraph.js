// =============================================================================
// TRANSMUTATION GRAPH SECTION
//
// Owns: the offset-graph canvas, the scaling/reposition sliders, and the
// data-point annotations. All DOM behavior for this section lives inside
// `transmutationGraphSection`, which only runs when a document exists.
//
// The data half lives above it in the "pure core" block: it builds the raw
// transmutation table (which GFD pool every magic pair and multiplier reaches)
// with no DOM and no globals, so the table tests can drive it from node. The
// section keeps its own local copies of the SI/RB auras and the "magicAbsMax"
// upper bound, reads the spell catalog and the raw pool lookup
// (`getPossibleGFDs`) from the central app.js / gfdss.js core, and republishes
// `equivalentContent` for other sections.
// =============================================================================

// =============================================================================
// PURE CORE
//
// The raw transmutation table in this section's own encoding: every distinct
// GFD pool becomes an entry in `allGFDConfigs` (empty pool first, full list
// second, then the rest widest first), and `dataPoints[currentMagic][maxMagic]`
// packs the pool index each multiplier reaches as four base-100 digits, with
// {1, 0.9, 0.99, 0.89} from the least significant digit up.
// =============================================================================

/** The full tag list: every spell, in catalog order. */
export const FULL_GFD_CONFIG = ["cbg", "fthof", "st", "se", "hc", "scp", "ra", "di"];

/** Element-wise array equality; a GFD pool is identified by its tag list. */
export function equivalentContent(a1, a2) {
    if (a1.length !== a2.length) return false;
    for (let i in a1) {
        if (a1[i] !== a2[i]) return false;
    }
    return true;
}

/** Index of the pool in `arr` equivalent to `item`, or -1 when absent. */
export function equivalentIndexOf(arr, item) {
    for (let i = 0; i < arr.length; i++) {
        if (equivalentContent(arr[i], item)) return i;
    }
    return -1;
}

/**
 * The four multiplier auras, derived the way this section derives them:
 * {1, 0.9, 0.99, 0.89}. The derived values are bit-identical to the literals
 * the transmutation tables use, which the table tests assert.
 */
export function auraMatrix() {
    return [
        1 - ((0 % 2 === 1) ? 0.1 : 0) - ((0 >= 2) ? 0.01 : 0),
        1 - ((1 % 2 === 1) ? 0.1 : 0) - ((1 >= 2) ? 0.01 : 0),
        1 - ((2 % 2 === 1) ? 0.1 : 0) - ((2 >= 2) ? 0.01 : 0),
        1 - ((3 % 2 === 1) ? 0.1 : 0) - ((3 >= 2) ? 0.01 : 0)
    ];
}

/**
 * Builds the raw transmutation table over [0, magicAbsMax] on both axes.
 *
 * `getPossibleGFDs(currentMagic, maxMagic, mult)` is the app core's pool lookup,
 * `spells` the full tag list and `matrix` the multiplier auras. `minMax` /
 * `maxSample` bound the max-magic window sampled for distinct pools: it has to
 * cover the grid, or a reachable pool would be missing from `allGFDConfigs` and
 * be encoded as -1.
 */
export function buildTransmutationTable({
    getPossibleGFDs,
    magicAbsMax,
    spells = FULL_GFD_CONFIG,
    matrix = auraMatrix(),
    minMax = 5,
    maxSample = 199
}) {
    const configs = [];
    for (let i = 0; i < 4; i++) {
        for (let cur = 0; cur <= magicAbsMax; cur++) {
            for (let max = minMax; max <= maxSample; max++) {
                const gfd = getPossibleGFDs(cur, max, matrix[i]);
                if (equivalentIndexOf(configs, gfd) !== -1) continue;
                configs.push(gfd);
            }
        }
    }

    const emptyIdx = equivalentIndexOf(configs, []);
    if (emptyIdx !== -1) configs.splice(emptyIdx, 1);
    const fullIdx = equivalentIndexOf(configs, spells);
    if (fullIdx !== -1) configs.splice(fullIdx, 1);

    const allGFDConfigs = [[], spells];
    const l = configs.length;
    loop:
    for (let i = 0; i < l; i++) {
        for (let ii = 0; ii < configs.length; ii++) {
            if (configs[ii].length === allGFDConfigs[allGFDConfigs.length - 1].length) {
                allGFDConfigs.push(configs[ii]);
                configs.splice(ii, 1);
                continue loop;
            }
        }
        for (let ii = 0; ii < configs.length; ii++) {
            if (configs[ii].length === allGFDConfigs[allGFDConfigs.length - 1].length - 1) {
                allGFDConfigs.push(configs[ii]);
                configs.splice(ii, 1);
                continue loop;
            }
        }
    }

    const allCounts = [];
    for (let i = 0; i < allGFDConfigs.length; i++) allCounts.push(0);

    const dataPoints = [];
    for (let i = 0; i <= magicAbsMax; i++) {
        dataPoints[i] = [];
        for (let ii = 0; ii <= magicAbsMax; ii++) {
            const a = equivalentIndexOf(allGFDConfigs, getPossibleGFDs(i, ii, matrix[0]));
            const b = equivalentIndexOf(allGFDConfigs, getPossibleGFDs(i, ii, matrix[1]));
            const c = equivalentIndexOf(allGFDConfigs, getPossibleGFDs(i, ii, matrix[2]));
            const d = equivalentIndexOf(allGFDConfigs, getPossibleGFDs(i, ii, matrix[3]));
            allCounts[a]++;
            allCounts[b]++;
            allCounts[c]++;
            allCounts[d]++;
            dataPoints[i].push(a + b * 100 + c * 10000 + d * 1000000);
        }
    }

    return { allGFDConfigs: allGFDConfigs, allCounts: allCounts, dataPoints: dataPoints };
}

function transmutationGraphSection() {
    "use strict";

    // ---- DOM references (scoped to this section) ----------------------------
    const openButton              = document.getElementById("offsetVisualOpenButton");
    const relatedEl               = document.getElementById("offsetVisualRelated");
    const offsetGraphCanvas       = document.getElementById("offsetGraph");
    const interactiveCanvas       = document.getElementById("offsetGraphInteractiveDisplay");
    const canvasContainer         = document.getElementById("canvasContainer");
    const dataAnnotations         = document.getElementById("dataAnnotations");
    const iconsImg                = document.getElementById("iconsImg");
    const scalingSlider           = document.getElementById("scalingSlider");
    const xSlider                 = document.getElementById("xSlider");
    const ySlider                 = document.getElementById("ySlider");
    const scalingSliderValue      = document.getElementById("scalingSliderValue");
    const xSliderValue            = document.getElementById("xSliderValue");
    const ySliderValue            = document.getElementById("ySliderValue");
    const si2Input                = document.getElementById("SI2");
    const rb2Input                = document.getElementById("RB2");
    const maxMaxManaInput         = document.getElementById("maxmaxmana");

    // ---- Local state: magic cap, data points, config list -------------------
    let magicAbsMax = 200;
    let dataPoints = [];
    let allGFDConfigs = [
        [],
        ["cbg", "fthof", "st", "se", "hc", "scp", "ra", "di"]
    ];
    const allCounts = [];

    // ---- Section-local SI/RB auras ------------------------------------------
    // The Transmutation graph section owns the hidden #SI2 / #RB2
    // checkboxes and keeps its own copy of the aura state. The multiplier
    // matrix {1, 0.9, 0.99, 0.89} lives in the pure core above and is read
    // from there on every build. Nothing is read from any shared aura mirror.
    let localSi = false;
    let localRb = false;
    function syncAurasFromCore() {
        if (si2Input) localSi = !!si2Input.checked;
        if (rb2Input) localRb = !!rb2Input.checked;
    }

    // ---- Color palette and helpers ------------------------------------------
    const colors = [
        `rgb(95, 95, 95)`, `rgb(255, 255, 255)`, `rgb(141, 67, 67)`,
        `rgb(255, 222, 58)`, `rgb(73, 255, 213)`, `rgb(255, 126, 94)`,
        `rgb(109, 65, 243)`, `rgb(73, 163, 133)`, `rgb(155, 146, 255)`,
        `rgb(255, 225, 190)`, `rgb(242, 0, 255)`, `rgb(21, 255, 0)`,
        `rgb(179, 0, 255)`, `rgb(255, 174, 213)`, `rgb(153, 212, 59)`,
        `rgb(8, 112, 135)`, `rgb(17, 22, 123)`, `rgb(30, 0, 255)`,
        `rgb(126, 143, 155)`, `rgb(59, 144, 255)`, `rgb(255, 136, 0)`,
        `rgb(83, 125, 70)`, `rgb(139, 72, 111)`
    ];

    function buildData() {
        syncAurasFromCore();
        const built = buildTransmutationTable({
            getPossibleGFDs: function (cur, max, mult) {
                return (typeof window.getPossibleGFDs === "function")
                    ? window.getPossibleGFDs(cur, max, mult)
                    : [];
            },
            magicAbsMax: magicAbsMax
        });
        // Copy into the existing arrays so the references this section already
        // published on `window` keep pointing at the fresh data.
        allGFDConfigs.length = 0;
        for (let i = 0; i < built.allGFDConfigs.length; i++) {
            allGFDConfigs.push(built.allGFDConfigs[i]);
        }
        allCounts.length = 0;
        for (let i = 0; i < built.allCounts.length; i++) allCounts.push(built.allCounts[i]);
        dataPoints.length = 0;
        for (let i = 0; i < built.dataPoints.length; i++) dataPoints[i] = built.dataPoints[i];
    }

    // ---- Canvas drawing -----------------------------------------------------
    const scaleFactor = 3;
    let squareSize = 4 * scaleFactor;
    let initialX = 5;
    let initialY = 5;

    function drawCrate(ctx, topLeftX, topLeftY, size, c, stroke) {
        const corners = [
            { x: topLeftX, y: topLeftY },
            { x: topLeftX + size, y: topLeftY },
            { x: topLeftX + size, y: topLeftY + size },
            { x: topLeftX, y: topLeftY + size }
        ];
        const center = { x: topLeftX + size / 2, y: topLeftY + size / 2 };
        for (let i = 0; i < 4; i++) {
            const c1 = corners[i];
            const c2 = corners[(i + 1) % 4];
            ctx.beginPath();
            ctx.moveTo(center.x, center.y);
            ctx.lineTo(c1.x, c1.y);
            ctx.lineTo(c2.x, c2.y);
            ctx.closePath();
            if (stroke) { ctx.strokeStyle = c[i]; ctx.stroke(); }
            else        { ctx.fillStyle   = c[i]; ctx.fill();   }
        }
    }

    function drawData() {
        if (!offsetGraphCanvas) return;
        const ctx = offsetGraphCanvas.getContext("2d");
        ctx.fillStyle = "black";
        const dim = (magicAbsMax + 1 - 5) * squareSize;
        const dimY = dim;
        offsetGraphCanvas.width = dim;
        offsetGraphCanvas.style.width = (dim / scaleFactor) + "px";
        if (interactiveCanvas) {
            interactiveCanvas.width = dim;
            interactiveCanvas.style.width = (dim / scaleFactor) + "px";
        }
        if (canvasContainer) canvasContainer.style.width = (dim / scaleFactor) + "px";
        offsetGraphCanvas.height = dimY;
        offsetGraphCanvas.style.height = (dimY / scaleFactor) + "px";
        if (interactiveCanvas) {
            interactiveCanvas.height = offsetGraphCanvas.height;
            interactiveCanvas.style.height = (dimY / scaleFactor) + "px";
        }
        if (canvasContainer) canvasContainer.style.height = (offsetGraphCanvas.height / scaleFactor) + "px";
        const width = dim;
        const height = dim;
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;
        for (let i = initialY; i <= initialY + magicAbsMax - 5; i++) {
            for (let ii = initialX; ii <= initialX + magicAbsMax - 5; ii++) {
                if (i > ii) ctx.globalAlpha = 0.2; else ctx.globalAlpha = 1;
                const point = (dataPoints[i] && dataPoints[i][ii] != null
                    ? dataPoints[i][ii] : 0) + 0.000000001;
                const c = [
                    colors[Math.floor((point / 100        - Math.floor(point / 100))        * 100)],
                    colors[Math.floor((point / 10000      - Math.floor(point / 10000))      * 100)],
                    colors[Math.floor((point / 1000000    - Math.floor(point / 1000000))    * 100)],
                    colors[Math.floor((point / 100000000  - Math.floor(point / 100000000))  * 100)]
                ];
                drawCrate(ctx,
                    (ii - initialX) * squareSize,
                    height - (i - initialY) * squareSize - squareSize,
                    squareSize, c);
            }
        }
    }

    function rescale(newSquareSize) {
        squareSize = newSquareSize * scaleFactor;
        magicAbsMax = Math.floor(196 * (4 / newSquareSize)) + 4;
        drawData();
    }

    function reposition(x, y) {
        initialX = x;
        initialY = y;
        drawData();
        updateDataInteractive(lastHoverX, lastHoverY);
    }

    const allowedSliderNodes = [];
    for (let i = 4; i < 64; i++) {
        const v = Math.floor(196 * (4 / i));
        if (!allowedSliderNodes.includes(v)) allowedSliderNodes.push(v);
    }

    if (scalingSlider) {
        scalingSlider.addEventListener("change", function (event) {
            const sliderValue = parseInt(scalingSlider.value);
            const closest = allowedSliderNodes.reduce(function (prev, curr) {
                return Math.abs(curr - sliderValue) < Math.abs(prev - sliderValue) ? curr : prev;
            });
            scalingSlider.value = closest;
            if (scalingSliderValue) scalingSliderValue.textContent = closest;
            rescale(Math.round(4 * 196 / closest));
            if (xSlider) xSlider.max = 5 + 196 - closest;
            if (ySlider) ySlider.max = 5 + 196 - closest;
            initialX = Math.min(initialX, 5 + 196 - closest);
            initialY = Math.min(initialY, 5 + 196 - closest);
        });
    }
    if (xSlider) xSlider.addEventListener("change", function (event) {
        reposition(parseInt(event.target.value), initialY);
    });
    if (ySlider) ySlider.addEventListener("change", function (event) {
        reposition(initialX, parseInt(event.target.value));
    });

    // Keyboard panning.
    document.addEventListener("keydown", function (event) {
        let changed = false;
        const mult = Math.pow(3, Number(event.shiftKey) + Number(event.ctrlKey));
        if (event.key === "ArrowLeft") {
            if (initialX > 0) { initialX = Math.max(initialX - mult, 0); changed = true; }
        } else if (event.key === "ArrowRight") {
            if (initialX < parseInt(xSlider.max)) { initialX = Math.min(initialX + mult, parseInt(xSlider.max)); changed = true; }
        } else if (event.key === "ArrowUp") {
            if (initialY < parseInt(ySlider.max)) { initialY = Math.min(initialY + mult, parseInt(ySlider.max)); changed = true; }
        } else if (event.key === "ArrowDown") {
            if (initialY > 0) { initialY = Math.max(initialY - mult, 0); changed = true; }
        } else { return; }
        event.preventDefault();
        if (changed) {
            reposition(initialX, initialY);
            if (xSlider) { xSlider.value = initialX; if (xSliderValue) xSliderValue.textContent = xSlider.value; }
            if (ySlider) { ySlider.value = initialY; if (ySliderValue) ySliderValue.textContent = ySlider.value; }
        }
    });

    // ---- Annotation strip ---------------------------------------------------
    function annotateData() {
        if (!dataAnnotations) return;
        const spells = (typeof window !== "undefined" && window.spells) || {};
        let str = '<div class="box" style="background: ' + colors[0] + '">0 (cannot cast, <div style="display: inline-block; font-size: 80%;">' + allCounts[0] + '</div>)</div>';
        for (let i = 1; i < allGFDConfigs.length; i++) {
            str += '<div class="box" style="background: ' + colors[i] + '">' + allGFDConfigs[i].length;
            for (let ii in allGFDConfigs[i]) {
                const sp = spells[allGFDConfigs[i][ii]];
                if (!sp || !sp.icon) continue;
                str += '<div class="icon" style="background-position: -' + (sp.icon[0] * 48)
                    + 'px -' + (sp.icon[1] * 48) + 'px;"></div>';
            }
            str += '<div style="display: inline-block; font-size: 80%;">(' + allCounts[i] + ')</div>';
            str += '</div>';
        }
        dataAnnotations.innerHTML = str;
    }

    // ---- Interactive overlay (hover zoom) -----------------------------------
    const additionalDisplayRadius = 3;
    const additionalDisplaySquareSize = 30 * scaleFactor;
    const upperLeftAnchor = [25 * scaleFactor, 25 * scaleFactor];
    const sirbConfigIcons = [
        [5, 10],
        [34, 25],
        [32, 25],
        [10, 25]
    ];
    const funnyFrameColorsBorders = [
        "#45045fff", "#19045fff", "#45045fff", "#19045fff"
    ];
    let lastHoverX = 0;
    let lastHoverY = 0;

    function updateDataInteractive(x, y) {
        if (!interactiveCanvas) return;
        const ctx = interactiveCanvas.getContext("2d");
        lastHoverX = x;
        lastHoverY = y;
        x *= scaleFactor;
        y *= scaleFactor;
        x = Math.floor(x / squareSize) + initialX;
        y = magicAbsMax - Math.floor(y / squareSize) + initialY - 5;
        const dim = (additionalDisplayRadius * 2 + 1) * additionalDisplaySquareSize;

        ctx.clearRect(0, 0, offsetGraphCanvas.width, offsetGraphCanvas.height);

        ctx.fillStyle = "rgba(102, 102, 102, 0.21)";
        for (let i = 50; i < magicAbsMax; i += 50) {
            ctx.fillRect(0, i * squareSize - 1, offsetGraphCanvas.width, 1);
            ctx.fillRect((i - 5) * squareSize - 1, 0, 1, offsetGraphCanvas.height);
        }
        ctx.fillStyle = "white";
        let count = 0;
        for (let i of [5, 10, 50]) {
            for (let ii = i; ii < magicAbsMax; ii += i) {
                const longSide  = 5 * (2 ** count);
                const shortSide = 2 + count;
                ctx.fillRect(0, ii * squareSize - shortSide / 2, longSide, shortSide);
                ctx.fillRect((ii - 5) * squareSize - shortSide / 2, 0, shortSide, longSide);
            }
            count++;
        }

        ctx.fillStyle = "white";
        ctx.fillRect(upperLeftAnchor[0] - 5 * scaleFactor, upperLeftAnchor[1] - 5 * scaleFactor, dim + 10 * scaleFactor, dim + 10 * scaleFactor);
        ctx.fillStyle = "black";
        ctx.fillRect(upperLeftAnchor[0] - 2 * scaleFactor, upperLeftAnchor[1] - 2 * scaleFactor, dim + 4 * scaleFactor, dim + 4 * scaleFactor);
        ctx.lineWidth = 2;
        for (let i = -additionalDisplayRadius; i <= additionalDisplayRadius; i++) {
            for (let ii = -additionalDisplayRadius; ii <= additionalDisplayRadius; ii++) {
                const cell = (dataPoints[y + ii] && dataPoints[y + ii][x + i] != null)
                    ? dataPoints[y + ii][x + i] : -1;
                if (cell === -1) {
                    ctx.fillStyle = "black";
                    ctx.fillRect(upperLeftAnchor[0] + (additionalDisplayRadius + i) * additionalDisplaySquareSize,
                        upperLeftAnchor[1] + (additionalDisplayRadius - ii) * additionalDisplaySquareSize,
                        additionalDisplaySquareSize, additionalDisplaySquareSize);
                } else {
                    const point = cell + 0.000000001;
                    const c = [
                        colors[Math.floor((point / 100       - Math.floor(point / 100))       * 100)],
                        colors[Math.floor((point / 10000     - Math.floor(point / 10000))     * 100)],
                        colors[Math.floor((point / 1000000   - Math.floor(point / 1000000))   * 100)],
                        colors[Math.floor((point / 100000000 - Math.floor(point / 100000000)) * 100)]
                    ];
                    drawCrate(ctx,
                        upperLeftAnchor[0] + (additionalDisplayRadius + i) * additionalDisplaySquareSize,
                        upperLeftAnchor[1] + (additionalDisplayRadius - ii) * additionalDisplaySquareSize,
                        additionalDisplaySquareSize, c);
                    if (y + ii > x + i) {
                        drawCrate(ctx,
                            upperLeftAnchor[0] + (additionalDisplayRadius + i) * additionalDisplaySquareSize,
                            upperLeftAnchor[1] + (additionalDisplayRadius - ii) * additionalDisplaySquareSize,
                            additionalDisplaySquareSize, funnyFrameColorsBorders, true);
                    }
                }
            }
        }
        ctx.fillStyle = "rgba(102, 102, 102, 0.21)";
        for (let i = 1; i <= additionalDisplayRadius * 2; i++) {
            ctx.fillRect(upperLeftAnchor[0], upperLeftAnchor[1] + i * additionalDisplaySquareSize - 1, dim, 2);
            ctx.fillRect(upperLeftAnchor[0] + i * additionalDisplaySquareSize - 1, upperLeftAnchor[1], 2, dim);
        }
        ctx.fillStyle = "red";
        ctx.fillRect(upperLeftAnchor[0] + additionalDisplayRadius * additionalDisplaySquareSize - 2, upperLeftAnchor[1], 3 * scaleFactor, dim);
        ctx.fillRect(upperLeftAnchor[0] + additionalDisplayRadius * additionalDisplaySquareSize + additionalDisplaySquareSize - 2, upperLeftAnchor[1], 3 * scaleFactor, dim);
        ctx.fillRect(upperLeftAnchor[0], upperLeftAnchor[1] + additionalDisplayRadius * additionalDisplaySquareSize - 2, dim, 3 * scaleFactor);
        ctx.fillRect(upperLeftAnchor[0], upperLeftAnchor[1] + additionalDisplayRadius * additionalDisplaySquareSize + additionalDisplaySquareSize - 2, dim, 3 * scaleFactor);

        ctx.strokeStyle = "black";
        ctx.lineWidth = 3 * scaleFactor;
        ctx.font = "bold " + (18 * scaleFactor) + "px serif";
        ctx.fillStyle = "white";
        ctx.strokeText("These are what you can get if you have", upperLeftAnchor[0], upperLeftAnchor[1] + dim + 30 * scaleFactor);
        ctx.strokeText(y + " / " + x + " mana", upperLeftAnchor[0], upperLeftAnchor[1] + dim + 56 * scaleFactor);
        ctx.strokeText("(" + initialY + " / " + initialX + ") to (" + (initialY + magicAbsMax) + " / " + (initialX + magicAbsMax) + ")", upperLeftAnchor[0], upperLeftAnchor[1] + dim + 82 * scaleFactor);
        ctx.fillText("These are what you can get if you have", upperLeftAnchor[0], upperLeftAnchor[1] + dim + 30 * scaleFactor);
        if (y > x) ctx.fillStyle = "#ee1e1eff";
        ctx.fillText(y + " / " + x + " mana", upperLeftAnchor[0], upperLeftAnchor[1] + dim + 56 * scaleFactor);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("(" + initialY + " / " + initialX + ") to (" + (initialY + magicAbsMax) + " / " + (initialX + magicAbsMax) + ")", upperLeftAnchor[0], upperLeftAnchor[1] + dim + 82 * scaleFactor);

        const spells = (typeof window !== "undefined" && window.spells) || {};
        for (let i = 1; i <= 4; i++) {
            const cell = (dataPoints[y] && dataPoints[y][x] != null) ? dataPoints[y][x] : 0;
            const point = cell + 0.000000001;
            const config = allGFDConfigs[Math.floor((point / (100 ** i) - Math.floor(point / (100 ** i))) * 100)];
            const indicator = ["#333333", "#333333", "#333333", "#333333"];
            indicator[i - 1] = colors[equivalentIndexOf(allGFDConfigs, config)];
            drawCrate(ctx, upperLeftAnchor[0] + dim + 18 * scaleFactor, upperLeftAnchor[1] + (i - 1) * 36 * scaleFactor, 24 * scaleFactor, indicator);
            if (iconsImg) {
                ctx.drawImage(iconsImg, sirbConfigIcons[i - 1][0] * 48, sirbConfigIcons[i - 1][1] * 48, 48, 48,
                    upperLeftAnchor[0] + dim + 48 * scaleFactor,
                    upperLeftAnchor[1] - 3 * scaleFactor + 36 * (i - 1) * scaleFactor,
                    30 * scaleFactor, 30 * scaleFactor);
            }
            ctx.fillStyle = "white";
            if (!config.length) {
                ctx.strokeText("(none)", upperLeftAnchor[0] + dim + 84 * scaleFactor, upperLeftAnchor[1] + 18 * scaleFactor + (i - 1) * 36 * scaleFactor);
                ctx.fillText("(none)", upperLeftAnchor[0] + dim + 84 * scaleFactor, upperLeftAnchor[1] + 18 * scaleFactor + (i - 1) * 36 * scaleFactor);
                continue;
            }
            ctx.strokeText(config.length, upperLeftAnchor[0] + dim + 84 * scaleFactor, upperLeftAnchor[1] + 18 * scaleFactor + (i - 1) * 36 * scaleFactor);
            ctx.fillText(config.length, upperLeftAnchor[0] + dim + 84 * scaleFactor, upperLeftAnchor[1] + 18 * scaleFactor + (i - 1) * 36 * scaleFactor);
            for (let ii = 0; ii < config.length; ii++) {
                const sp = spells[config[ii]];
                if (!sp || !sp.icon || !iconsImg) continue;
                ctx.drawImage(iconsImg, sp.icon[0] * 48, sp.icon[1] * 48, 48, 48,
                    upperLeftAnchor[0] + dim + 100 * scaleFactor + ii * 30 * scaleFactor,
                    upperLeftAnchor[1] + 36 * (i - 1) * scaleFactor,
                    24 * scaleFactor, 24 * scaleFactor);
            }
        }
    }

    if (interactiveCanvas) {
        interactiveCanvas.addEventListener("mousemove", function (e) {
            let posx = 0, posy = 0;
            if (e.clientX || e.clientY) {
                posx = e.clientX + document.body.scrollLeft;
                posy = e.clientY + document.body.scrollTop;
            }
            updateDataInteractive(
                posx - interactiveCanvas.getBoundingClientRect().left,
                posy - interactiveCanvas.getBoundingClientRect().top
            );
        });
    }

    // Disable the wheel on focused number inputs (used by all sections but
    // wired here so load order does not matter).
    document.querySelectorAll('input[type=number]').forEach(function (input) {
        input.addEventListener("wheel", function (event) {
            if (document.activeElement === this) event.preventDefault();
        });
    });

    // ---- Open-button handler -----------------------------------------------
    if (openButton && relatedEl) {
        openButton.addEventListener("click", function () {
            redrawAll(true);
            rescale(8);
            relatedEl.classList.remove("hidden");
            openButton.classList.add("hidden");
        });
    }

    // ---- Public redraw + onChange hooks ------------------------------------
    function redrawAll(init) {
        buildData();
        drawData();
        annotateData();
        if (!init) updateDataInteractive(lastHoverX, lastHoverY);
    }

    if (si2Input) si2Input.addEventListener("change", function () {
        syncAurasFromCore();
        if (dataPoints.length) redrawAll();
    });
    if (rb2Input) rb2Input.addEventListener("change", function () {
        syncAurasFromCore();
        if (dataPoints.length) redrawAll();
    });

    // Wire the section's own magicAbsMax to the on-page `maxmaxmana` input.
    // The onchange handler in index.html assigns the parsed value to the
    // global `magicAbsMax`; we mirror it into the section's local copy and
    // trigger a redraw if the graph is already shown. The `maxmaxmana` input
    // and the hidden `SI2` / `RB2` checkboxes are owned by this section —
    // they are not consumed by any other section.
    if (maxMaxManaInput) {
        maxMaxManaInput.addEventListener("change", function () {
            const v = parseInt(maxMaxManaInput.value);
            if (!isNaN(v)) {
                magicAbsMax = v;
                if (dataPoints.length) redrawAll();
            }
        });
    }

    // Re-publish the section's state and helpers on the global namespace so
    // that legacy code (the `maxmaxmana` inline onchange handler, etc.)
    // keeps working without depending on the section's internals.
    window.dataPoints = dataPoints;
    window.allGFDConfigs = allGFDConfigs;
    window.magicAbsMax = magicAbsMax;
    window.redrawAll = redrawAll;
    window.offsetGraph = offsetGraphCanvas;
    window.equivalentContent = equivalentContent;
    // The `maxmaxmana` input is section-owned; expose as an alias for the
    // inline onchange handler in index.html.
    window.maxmaxmana = maxMaxManaInput;

    // ---- API: explicit, narrow section surface -----------------------------
    window.transmutationGraphApi = {
        getState: function () {
            return {
                si: !!(si2Input && si2Input.checked),
                rb: !!(rb2Input && rb2Input.checked),
                magicAbsMax: magicAbsMax,
                initialX: initialX,
                initialY: initialY
            };
        },
        setAuras: function (si, rb) {
            if (si2Input) si2Input.checked = !!si;
            if (rb2Input) rb2Input.checked = !!rb;
            syncAurasFromCore();
            if (dataPoints.length) redrawAll();
        },
        setMagicAbsMax: function (v) {
            magicAbsMax = v;
        },
        redraw: function () { redrawAll(); }
    };
}

// The section is DOM-only; importing this file under node (the table tests do)
// gives the pure core above without touching a document.
if (typeof document !== "undefined") {
    transmutationGraphSection();
}
