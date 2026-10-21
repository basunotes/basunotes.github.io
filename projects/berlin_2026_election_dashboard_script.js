"use strict";

// Berlin Election 2026 — geographic explorer.
// No Python, Leaflet, map tiles, or external JS libraries are needed.
// The GeoJSON loads automatically from website/data/ when this page is
// hosted as a static site (e.g. VS Code Live Server or GitHub Pages).

(() => {
    const DATA_URL = "./data/berlin_2026_election_areas.geojson";
    const $ = (id) => document.getElementById(id);
    const svgNS = "http://www.w3.org/2000/svg";
    const fmt = new Intl.NumberFormat("en-GB");

    const parties = [
        { id: "die_linke", name: "Die Linke", color: "#bb397e" },
        { id: "cdu", name: "CDU", color: "#44464b" },
        { id: "spd", name: "SPD", color: "#dc3945" },
        { id: "gruene", name: "GRÜNE", color: "#389448" },
        { id: "afd", name: "AfD", color: "#278bca" },
        { id: "bsw", name: "BSW", color: "#714095" },
        { id: "fdp", name: "FDP", color: "#d5b320" },
        { id: "tierschutzpartei", name: "Tierschutzpartei", color: "#bd8047" },
        { id: "die_partei", name: "Die PARTEI", color: "#b6493b" },
        { id: "volt", name: "Volt", color: "#7153bc" },
        { id: "die_urbane", name: "Die Urbane.", color: "#659fba" },
        { id: "dkp", name: "DKP", color: "#9e5761" },
        { id: "oedp", name: "ÖDP", color: "#81964f" },
        { id: "heimat", name: "HEIMAT", color: "#80766c" },
        { id: "b_star", name: "B*", color: "#b878ac" },
        { id: "sgp", name: "SGP", color: "#a58a74" },
        { id: "pdf", name: "PdF", color: "#66819a" },
    ];
    const partyById = Object.fromEntries(parties.map((p) => [p.id, p]));
    const boroughNames = {
        "01": "Mitte",
        "02": "Friedrichshain-Kreuzberg",
        "03": "Pankow",
        "04": "Charlottenburg-Wilmersdorf",
        "05": "Spandau",
        "06": "Steglitz-Zehlendorf",
        "07": "Tempelhof-Schöneberg",
        "08": "Neukölln",
        "09": "Treptow-Köpenick",
        10: "Marzahn-Hellersdorf",
        11: "Lichtenberg",
        12: "Reinickendorf",
    };

    const svg = $("electionSvg");
    const viewport = $("mapViewport");
    const tooltip = $("mapTooltip");
    const modeControl = $("mapMode");
    const partyControl = $("partySelect");

    let areas = [];
    let boroughs = new Map();
    let berlin = null;
    let active = null;
    let paths = [];
    let districtPaths = [];
    let districtOutlines = [];
    let districtLabels = [];
    let districtGeometries = new Map();
    let areaLayer, districtLayer, outlineLayer, highlightLayer, labelLayer;
    let hoveredPath = null;
    let focusedPath = null;
    let selectedPath = null;
    let hoverHighlight, selectedHighlight;
    let projection = null;
    let baseView = null;
    let currentView = null;
    let dragging = null;
    let suppressClick = false;

    function number(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function percent(value) {
        return `${value.toFixed(1)}%`;
    }

    function share(summary, partyId) {
        return summary.valid > 0 ? (100 * summary.votes[partyId]) / summary.valid : 0;
    }

    function leader(summary) {
        return parties.reduce(
            (best, party) => (!best || summary.votes[party.id] > summary.votes[best.id] ? party : best),
            null
        );
    }

    function aggregate(records, name, key) {
        const result = {
            name,
            key,
            valid: 0,
            votes: Object.fromEntries(parties.map((p) => [p.id, 0])),
            areaCount: records.length,
        };
        for (const area of records) {
            result.valid += area.valid;
            for (const party of parties) result.votes[party.id] += area.votes[party.id];
        }
        return result;
    }

    function prepareData(geojson) {
        if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
            throw new Error("Expected a GeoJSON FeatureCollection.");
        }
        if (geojson.features.length !== 1572) {
            throw new Error(`Expected 1,572 election areas; found ${geojson.features.length}.`);
        }
        const seen = new Set();
        areas = geojson.features.map((feature) => {
            const props = feature.properties || {};
            const key = String(props.area_id ?? "").trim();
            const match = /^(\d{2})_/.exec(key);
            if (!key || !match || !boroughNames[match[1]] || seen.has(key)) {
                throw new Error(`Invalid or duplicate voting-area code: ${key || "(empty)"}`);
            }
            if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
                throw new Error(`Missing or unsupported geometry for area ${key}.`);
            }
            seen.add(key);
            const valid = number(props.valid_votes);
            if (!(valid > 0)) throw new Error(`Invalid vote total for ${key}.`);
            const votes = {};
            for (const party of parties) {
                const raw = props[`${party.id}_votes`];
                if (raw === undefined || raw === null || !Number.isFinite(Number(raw)) || number(raw) < 0) {
                    throw new Error(`Missing or invalid ${party.name} votes for ${key}.`);
                }
                votes[party.id] = number(raw);
            }
            if (Math.abs(Object.values(votes).reduce((a, b) => a + b, 0) - valid) > 0.001) {
                throw new Error(`All 17 party vote counts must equal valid votes for ${key}.`);
            }
            return {
                name: `Voting area ${key}`,
                key,
                bezirk: match[1],
                valid,
                votes,
                areaCount: 1,
                geometry: feature.geometry,
            };
        });

        const grouped = new Map();
        for (const area of areas) {
            if (!grouped.has(area.bezirk)) grouped.set(area.bezirk, []);
            grouped.get(area.bezirk).push(area);
        }
        if (grouped.size !== 12) {
            throw new Error(`Expected 12 Bezirk codes; found ${grouped.size}.`);
        }
        boroughs = new Map(
            [...grouped.entries()].map(([key, records]) => [key, aggregate(records, boroughNames[key], key)])
        );
        berlin = aggregate(areas, "Berlin overall", "berlin");
    }

    // The Bezirk boundaries are built from the union of the existing
    // election-area geometries and packaged with the offline data file.
    function prepareDistrictData(geojson) {
        if (
            !geojson ||
            geojson.type !== "FeatureCollection" ||
            !Array.isArray(geojson.features) ||
            geojson.features.length !== 12
        ) {
            throw new Error("Expected a second dataset with all 12 Bezirk polygons.");
        }
        districtGeometries = new Map();
        for (const feature of geojson.features) {
            const code = String(feature.properties?.bezirk_code ?? "");
            const p = feature.properties || {};
            if (
                !boroughs.has(code) ||
                districtGeometries.has(code) ||
                !feature.geometry ||
                !["Polygon", "MultiPolygon"].includes(feature.geometry.type) ||
                !Number.isFinite(Number(p.label_lon)) ||
                !Number.isFinite(Number(p.label_lat))
            ) {
                throw new Error(`Invalid Bezirk polygon or label: ${code}`);
            }
            districtGeometries.set(code, {
                geometry: feature.geometry,
                labelLon: Number(p.label_lon),
                labelLat: Number(p.label_lat),
                summary: boroughs.get(code),
            });
        }
        if (districtGeometries.size !== 12) throw new Error("Incomplete Bezirk boundaries.");
    }

    function forEveryCoordinate(geometry, visit) {
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
        for (const polygon of polygons) {
            for (const ring of polygon) {
                for (const position of ring) {
                    const x = Number(position[0]);
                    const y = Number(position[1]);
                    if (Number.isFinite(x) && Number.isFinite(y)) visit(x, y);
                }
            }
        }
    }

    function makeProjection() {
        const longitudeFactor = Math.cos((52.52 * Math.PI) / 180);
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const area of areas) {
            forEveryCoordinate(area.geometry, (lon, lat) => {
                const x = lon * longitudeFactor,
                    y = -lat;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            });
        }
        if (!(maxX > minX && maxY > minY)) throw new Error("Invalid GeoJSON coordinate bounds.");
        // Reject mistakenly unprojected GeoJSON such as EPSG:25833.
        if (minX > 20 || minY < -90) throw new Error("GeoJSON coordinates must be in EPSG:4326 (longitude/latitude).");
        const scale = 1000 / (maxX - minX);
        const height = (maxY - minY) * scale;
        projection = (lon, lat) => [(lon * longitudeFactor - minX) * scale, (-lat - minY) * scale];
        baseView = { x: -24, y: -24, w: 1048, h: height + 48 };
        currentView = { ...baseView };
        applyView();
    }

    function pathForGeometry(geometry, { includeHoles = true } = {}) {
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
        const commands = [];
        for (const polygon of polygons) {
            // GeoJSON puts the exterior boundary first. On dissolved Bezirk
            // polygons, microscopic interior rings can create dark scratches
            // when stroked, even though they have negligible geographic area.
            // Keep every ring for the actual voting-area geometries, but draw
            // only the exterior ring when rendering district fills/outlines.
            const rings = includeHoles ? polygon : polygon.slice(0, 1);
            for (const ring of rings) {
                if (ring.length < 3) continue;
                const coordinates = ring.map(([lon, lat]) => projection(lon, lat));
                for (let i = 0; i < coordinates.length; i++) {
                    const [x, y] = coordinates[i];
                    commands.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
                }
                commands.push("Z");
            }
        }
        return commands.join(" ");
    }

    function mixWithWhite(hex, fraction) {
        const t = Math.max(0, Math.min(fraction, 1));
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const base = [245, 247, 249];
        const mixed = rgb.map((value, i) => Math.round(base[i] * (1 - t) + value * t));
        return `rgb(${mixed.join(",")})`;
    }

    function summaryFor(area) {
        return modeControl.value === "bezirk" ? boroughs.get(area.bezirk) : area;
    }

    function paintColor(summary) {
        if (partyControl.value === "winner") {
            return mixWithWhite(leader(summary).color, 0.88);
        }
        const party = partyById[partyControl.value];
        return mixWithWhite(party.color, Math.min(share(summary, party.id) / 50, 1));
    }

    function makeSvgGroup(className) {
        const group = document.createElementNS(svgNS, "g");
        group.setAttribute("class", className);
        svg.appendChild(group);
        return group;
    }

    // Draw the same geometry a second time ABOVE the polygon and Bezirk
    // boundary layers, so neighboring shapes cannot cover the white stroke.
    // Labels remain above the outline and the overlay never intercepts clicks.
    function updateHighlightPaths() {
        if (!hoverHighlight || !selectedHighlight) return;

        const visible = (path) =>
            path &&
            (modeControl.value === "bezirk"
                ? path.classList.contains("map-bezirk")
                : path.classList.contains("map-voting-area"));

        const show = (highlight, path) => {
            if (visible(path)) {
                highlight.setAttribute("d", path.getAttribute("d"));
                highlight.style.display = "";
            } else {
                highlight.removeAttribute("d");
                highlight.style.display = "none";
            }
        };

        // Selection is drawn after hover, so its border remains most prominent.
        show(hoverHighlight, hoveredPath || focusedPath);
        show(selectedHighlight, selectedPath);
    }

    function registerMapInteraction(path, summary, select) {
        path.addEventListener("pointerenter", (event) => {
            hoveredPath = path;
            updateHighlightPaths();
            showTooltip(summary, event);
        });
        path.addEventListener("pointermove", moveTooltip);
        path.addEventListener("pointerleave", () => {
            if (hoveredPath === path) hoveredPath = null;
            updateHighlightPaths();
            tooltip.hidden = true;
        });
        // Keyboard focus uses the same geographic outline, not a blue rectangle.
        path.addEventListener("focus", () => {
            focusedPath = path;
            updateHighlightPaths();
        });
        path.addEventListener("blur", () => {
            if (focusedPath === path) focusedPath = null;
            updateHighlightPaths();
        });
        path.addEventListener("click", () => {
            if (!suppressClick) select();
        });
        path.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select();
            }
        });
    }

    function labelLines(name) {
        const split = {
            "Friedrichshain-Kreuzberg": ["Friedrichshain", "Kreuzberg"],
            "Charlottenburg-Wilmersdorf": ["Charlottenburg", "Wilmersdorf"],
            "Steglitz-Zehlendorf": ["Steglitz", "Zehlendorf"],
            "Tempelhof-Schöneberg": ["Tempelhof", "Schöneberg"],
            "Treptow-Köpenick": ["Treptow", "Köpenick"],
            "Marzahn-Hellersdorf": ["Marzahn", "Hellersdorf"],
        };
        return split[name] || [name];
    }

    function drawMap() {
        makeProjection();
        svg.replaceChildren();
        areaLayer = makeSvgGroup("voting-area-layer");
        districtLayer = makeSvgGroup("bezirk-fill-layer");
        outlineLayer = makeSvgGroup("bezirk-outline-layer");
        highlightLayer = makeSvgGroup("map-highlight-layer");
        labelLayer = makeSvgGroup("bezirk-label-layer");

        hoveredPath = null;
        focusedPath = null;
        selectedPath = null;
        hoverHighlight = document.createElementNS(svgNS, "path");
        hoverHighlight.setAttribute("class", "map-highlight-hover");
        selectedHighlight = document.createElementNS(svgNS, "path");
        selectedHighlight.setAttribute("class", "map-highlight-selected");
        highlightLayer.append(hoverHighlight, selectedHighlight);

        // In voting-area mode, each area is an independent hit target.
        // In Bezirk mode this layer is hidden altogether.
        const areaFragment = document.createDocumentFragment();
        paths = areas.map((area) => {
            const path = document.createElementNS(svgNS, "path");
            path.setAttribute("d", pathForGeometry(area.geometry));
            path.setAttribute("fill-rule", "evenodd");
            path.setAttribute("class", "map-region map-voting-area");
            path.setAttribute("role", "button");
            path.setAttribute("tabindex", "0");
            path.setAttribute("aria-label", area.name);
            registerMapInteraction(path, area, () => selectArea(area, path));
            areaFragment.appendChild(path);
            return { area, path };
        });
        areaLayer.appendChild(areaFragment);

        // Each Bezirk uses exactly ONE merged polygon, not 100+ voting areas.
        districtPaths = [];
        districtOutlines = [];
        districtLabels = [];
        for (const [code, district] of districtGeometries) {
            // Draw the administrative perimeter, not tiny holes left by
            // dissolving precinct boundaries. This same cleaned SVG path is
            // used for Bezirk fill, border overlay, and hover/selection.
            const d = pathForGeometry(district.geometry, { includeHoles: false });
            const path = document.createElementNS(svgNS, "path");
            path.setAttribute("d", d);
            path.setAttribute("fill-rule", "evenodd");
            path.setAttribute("class", "map-region map-bezirk");
            path.setAttribute("role", "button");
            path.setAttribute("tabindex", "0");
            path.setAttribute("aria-label", `Bezirk ${district.summary.name}`);
            registerMapInteraction(path, district.summary, () => selectDistrict(code, path));
            districtLayer.appendChild(path);
            districtPaths.push({ code, path });

            const outline = document.createElementNS(svgNS, "path");
            outline.setAttribute("d", d);
            outline.setAttribute("class", "bezirk-outline");
            outline.setAttribute("fill", "none");
            outlineLayer.appendChild(outline);
            districtOutlines.push(outline);

            const [x, y] = projection(district.labelLon, district.labelLat);
            const text = document.createElementNS(svgNS, "text");
            text.setAttribute("class", "bezirk-label");
            text.setAttribute("x", x);
            text.setAttribute("y", y);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("dominant-baseline", "middle");
            text.setAttribute("aria-hidden", "true");
            const lines = labelLines(district.summary.name);
            lines.forEach((line, index) => {
                const span = document.createElementNS(svgNS, "tspan");
                span.setAttribute("x", x);
                span.setAttribute("dy", index === 0 ? (lines.length === 1 ? "0" : "-0.45em") : "1.02em");
                span.textContent = line;
                text.appendChild(span);
            });
            labelLayer.appendChild(text);
            districtLabels.push(text);
        }
        updateMap();
    }

    function updateMap() {
        const boroughMode = modeControl.value === "bezirk";
        areaLayer.style.display = boroughMode ? "none" : "";
        districtLayer.style.display = boroughMode ? "" : "none";
        outlineLayer.style.display = boroughMode ? "none" : "";

        // The label layer remains visible, including during hover and selection.
        for (const { area, path } of paths) {
            path.setAttribute("fill", paintColor(area));
            path.setAttribute(
                "aria-pressed",
                String(!boroughMode && active?.type === "area" && active.key === area.key)
            );
            path.setAttribute("tabindex", boroughMode ? "-1" : "0");
        }
        for (const { code, path } of districtPaths) {
            path.setAttribute("fill", paintColor(boroughs.get(code)));
            path.setAttribute("aria-pressed", String(boroughMode && active?.type === "bezirk" && active.key === code));
            path.setAttribute("tabindex", boroughMode ? "0" : "-1");
        }
        updateHighlightPaths();
        $("mapRegionCount").textContent = boroughMode ? "12 Bezirke" : "1,572 voting areas";
        updateLegend();
        if (active) updateResults(active.summary);
        tooltip.hidden = true;
    }

    function updateLegend() {
        const legend = $("mapLegend");
        legend.replaceChildren();
        if (partyControl.value === "winner") {
            const label = document.createElement("span");
            label.textContent = "Leading party:";
            legend.appendChild(label);
            const visibleSummaries = modeControl.value === "bezirk" ? [...boroughs.values()] : areas;
            const visibleWinners = new Set(visibleSummaries.map((s) => leader(s).id));
            for (const party of parties.filter((p) => visibleWinners.has(p.id))) {
                const item = document.createElement("span");
                item.className = "legend-entry";
                const square = document.createElement("i");
                square.className = "legend-swatch";
                square.style.background = mixWithWhite(party.color, 0.88);
                const name = document.createElement("span");
                name.textContent = party.name;
                item.append(square, name);
                legend.appendChild(item);
            }
        } else {
            const label1 = document.createElement("span");
            label1.textContent = "0%";
            const gradient = document.createElement("div");
            gradient.className = "legend-gradient";
            const party = partyById[partyControl.value];
            gradient.style.background = `linear-gradient(to right, ${mixWithWhite(party.color, 0)}, ${mixWithWhite(party.color, 0.5)}, ${mixWithWhite(party.color, 1)})`;
            const label2 = document.createElement("span");
            label2.textContent = "50%+";
            const note = document.createElement("span");
            note.className = "legend-label";
            note.textContent = `${party.name} share of valid votes (fixed scale)`;
            legend.append(label1, gradient, label2, note);
        }
    }

    function showTooltip(summary, event) {
        tooltip.replaceChildren();
        const heading = document.createElement("strong");
        heading.textContent = summary.name;
        tooltip.appendChild(heading);
        if (partyControl.value === "winner") {
            const party = leader(summary);
            const line = document.createElement("div");
            line.textContent = `Leading party: ${party.name} (${percent(share(summary, party.id))})`;
            tooltip.appendChild(line);
        } else {
            const party = partyById[partyControl.value];
            const line = document.createElement("div");
            line.textContent = `${party.name}: ${percent(share(summary, party.id))} · ${fmt.format(summary.votes[party.id])} votes`;
            tooltip.appendChild(line);
        }

        const votes = document.createElement("div");
        votes.className = "muted";

        votes.textContent =
            summary.areaCount === 1
                ? `${fmt.format(summary.valid)} valid votes`
                : `${fmt.format(summary.valid)} valid votes · ${fmt.format(summary.areaCount)} voting areas`;

        tooltip.appendChild(votes);

        tooltip.hidden = false;
        moveTooltip(event);
    }

    function moveTooltip(event) {
        if (tooltip.hidden) return;
        const bounds = viewport.getBoundingClientRect();
        const x = Math.max(8, Math.min(event.clientX - bounds.left + 12, bounds.width - tooltip.offsetWidth - 8));
        const y = Math.max(8, Math.min(event.clientY - bounds.top + 12, bounds.height - tooltip.offsetHeight - 8));
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    }

    function selectArea(area, path) {
        if (modeControl.value !== "area") return;
        active = { type: "area", key: area.key, summary: area };
        selectedPath = path;
        updateResults(area);
        updateMap();
    }

    function selectDistrict(code, path) {
        if (modeControl.value !== "bezirk") return;
        const summary = boroughs.get(code);
        active = { type: "bezirk", key: code, summary };
        selectedPath = path;
        updateResults(summary);
        updateMap();
    }

    function updateResults(summary) {
        $("resultsLevel").textContent =
            summary.key === "berlin" ? "Berlin total" : active && active.type === "bezirk" ? "Bezirk" : "Voting area";
        $("resultsTitle").textContent = summary.name;
        const subtitle = $("resultsSubtitle");

        subtitle.hidden = summary.areaCount === 1;

        subtitle.textContent =
            summary.key === "berlin"
                ? `All ${fmt.format(summary.areaCount)} voting areas`
                : `${fmt.format(summary.areaCount)} voting areas in this selection`;
        $("validVotes").textContent = fmt.format(summary.valid);
        $("leadingParty").textContent = leader(summary).name;
        const rows = $("partyRows");
        rows.replaceChildren();

        // Parties displayed individually
        const mainPartyIds = new Set(["die_linke", "cdu", "spd", "gruene", "afd"]);

        // Major parties
        const displayedParties = parties
            .filter((party) => mainPartyIds.has(party.id))
            .map((party) => ({
                ...party,
                count: summary.votes[party.id],
            }))
            .sort((a, b) => b.count - a.count);

        // Combine all remaining parties
        const sonstigeVotes = parties
            .filter((party) => !mainPartyIds.has(party.id))
            .reduce((total, party) => total + summary.votes[party.id], 0);

        // Always show Sonstige last
        displayedParties.push({
            id: "sonstige",
            name: "Sonstige",
            color: "#9299a1",
            count: sonstigeVotes,
        });

        // Render results
        for (const party of displayedParties) {
            const tr = document.createElement("tr");

            if (partyControl.value === party.id) {
                tr.classList.add("is-chosen");
            }

            const partyCell = document.createElement("td");
            const name = document.createElement("span");
            name.className = "party-cell";

            const dot = document.createElement("i");
            dot.className = "party-dot";
            dot.style.background = party.color;

            const text = document.createElement("span");
            text.textContent = party.name;

            name.append(dot, text);
            partyCell.appendChild(name);

            const pct = summary.valid > 0 ? (100 * party.count) / summary.valid : 0;

            const percentageCell = document.createElement("td");

            const label = document.createElement("span");
            label.className = "party-share";
            label.textContent = percent(pct);

            const track = document.createElement("div");
            track.className = "share-underbar";

            const bar = document.createElement("span");
            bar.style.width = `${Math.min(pct, 100)}%`;
            bar.style.background = party.color;

            track.appendChild(bar);
            percentageCell.append(label, track);

            const countCell = document.createElement("td");
            countCell.textContent = fmt.format(party.count);

            tr.append(partyCell, percentageCell, countCell);
            rows.appendChild(tr);
        }
    }

    function clearSelection() {
        active = null;
        selectedPath = null;
        hoveredPath = null;
        focusedPath = null;
        updateResults(berlin);
        updateMap();
    }

    function applyView() {
        if (!currentView) return;
        svg.setAttribute("viewBox", `${currentView.x} ${currentView.y} ${currentView.w} ${currentView.h}`);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }

    function resetView() {
        currentView = { ...baseView };
        applyView();
    }

    function zoom(factor, center) {
        const minWidth = baseView.w / 16;
        const maxWidth = baseView.w * 1.2;
        const width = Math.max(minWidth, Math.min(maxWidth, currentView.w * factor));
        const adjusted = width / currentView.w;
        const origin = center || { x: currentView.x + currentView.w / 2, y: currentView.y + currentView.h / 2 };
        currentView = {
            x: origin.x - (origin.x - currentView.x) * adjusted,
            y: origin.y - (origin.y - currentView.y) * adjusted,
            w: width,
            h: currentView.h * adjusted,
        };
        applyView();
    }

    function eventToSvgPoint(event) {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const ctm = svg.getScreenCTM();
        return ctm
            ? point.matrixTransform(ctm.inverse())
            : { x: currentView.x + currentView.w / 2, y: currentView.y + currentView.h / 2 };
    }

    function setupInteractions() {
        $("zoomIn").addEventListener("click", () => zoom(0.8));
        $("zoomOut").addEventListener("click", () => zoom(1.25));
        // Both reset controls return to the Berlin-wide results and full map view.
        const resetMap = () => {
            clearSelection();
            resetView();
        };
        $("resetZoom").addEventListener("click", resetMap);
        $("resetSelection").addEventListener("click", resetMap);
        partyControl.addEventListener("change", () => {
            updateMap();
            updateResults(active ? active.summary : berlin);
        });
        modeControl.addEventListener("change", clearSelection);

        // Click empty SVG background to deselect without changing the zoom.
        // Region clicks are handled on the paths; map dragging is ignored.
        svg.addEventListener("click", (event) => {
            if (event.target === svg && !suppressClick) clearSelection();
        });

        svg.addEventListener(
            "wheel",
            (event) => {
                event.preventDefault();
                zoom(event.deltaY > 0 ? 1.15 : 0.87, eventToSvgPoint(event));
            },
            { passive: false }
        );

        svg.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            dragging = { x: event.clientX, y: event.clientY, moved: false };
        });
        svg.addEventListener("pointermove", (event) => {
            if (!dragging) return;
            const dx = event.clientX - dragging.x;
            const dy = event.clientY - dragging.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) {
                dragging.moved = true;
                if (!svg.hasPointerCapture(event.pointerId)) svg.setPointerCapture(event.pointerId);
            }
            if (!dragging.moved) return;
            svg.classList.add("dragging");
            const matrix = svg.getScreenCTM();
            const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
            currentView.x -= dx / scale;
            currentView.y -= dy / scale;
            applyView();
            dragging.x = event.clientX;
            dragging.y = event.clientY;
            tooltip.hidden = true;
        });
        function finishDrag(event) {
            if (!dragging) return;
            suppressClick = dragging.moved;
            svg.classList.remove("dragging");
            if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
            dragging = null;
            // Delay reset until after any synthesized click from the same gesture.
            setTimeout(() => {
                suppressClick = false;
            }, 0);
        }
        svg.addEventListener("pointerup", finishDrag);
        svg.addEventListener("pointercancel", finishDrag);
    }

    async function start() {
        setupInteractions();
        try {
            // Optional offline JS wrapper support: window.BERLIN_ELECTION_GEOJSON.
            // On a static host, the original .geojson is loaded automatically.
            let data = window.BERLIN_ELECTION_GEOJSON;
            if (!data) {
                if (location.protocol === "file:") {
                    throw new Error(
                        "Browsers block automatic JSON loading from file://. Open this folder " +
                            "using VS Code Live Server or publish it on GitHub Pages. " +
                            "No Python, file upload, or manual data selection is required."
                    );
                }
                const response = await fetch(DATA_URL);
                if (!response.ok) throw new Error(`Could not load ${DATA_URL} (HTTP ${response.status}).`);
                data = await response.json();
            }
            prepareData(data);
            prepareDistrictData(window.BERLIN_BEZIRKE_GEOJSON);
            drawMap();
            updateResults(berlin);
            $("mapStatus").textContent =
                `${fmt.format(areas.length)} voting areas across ${boroughs.size} Bezirke loaded successfully.`;
        } catch (error) {
            console.error("Berlin election map error:", error);
            $("mapStatus").textContent = error.message;
            $("mapStatus").classList.add("error");
            $("mapRegionCount").textContent = "Data not loaded";
        }
    }

    start();
})();

// ---------------------------------------------------
// Step 4 — Berlin-wide demographic voter-group explorer.
// Separate from the geographic map: surveys are NOT
// Bezirk-level results and don't change with map selection.
// ---------------------------------------------------
(() => {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const data = window.BERLIN_VOTER_GROUPS_DATA;
    const tabs = [...document.querySelectorAll(".voter-tab")];
    const selectA = $("voterGroupA");
    const selectB = $("voterGroupB");
    const status = $("voterStatus");
    const order = ["Die Linke", "CDU", "SPD", "GRÜNE", "AfD", "BSW", "FDP"];
    const colors = {
        "Die Linke": "#bb397e",
        CDU: "#44464b",
        SPD: "#dc3945",
        GRÜNE: "#389448",
        AfD: "#278bca",
        BSW: "#714095",
        FDP: "#dbb230",
    };
    const dimensionNames = {
        age: "Age",
        gender: "Gender",
        age_gender: "Age and gender",
        education: "Education",
        economic_situation: "Economic situation",
        religion: "Religious affiliation",
    };
    const notes = {
        age: "Age-group percentages are weighted Berlin-wide survey estimates; they are not votes counted by age in a specific area.",
        gender: "The published gender table reports men and women. The figures do not account for differences in age composition.",
        age_gender:
            "Each group is an age × gender combination. Estimates for small subgroups may be less precise; subgroup sample sizes are not provided here.",
        education:
            "Low, middle, and high are the survey's reported education categories, not verified individual degrees. Education is associated with other characteristics, so differences are not causal effects.",
        economic_situation:
            "This compares respondents' self-assessed economic situation. It is NOT a comparison of measured household-income brackets.",
        religion:
            "Religious affiliation is self-reported in the survey. The total survey size (17,460) is NOT the sample size of any single religious group. Estimates for smaller subgroups need caution.",
    };
    const displayNames = {
        Niedrig: "Low (Niedrig)",
        Mittel: "Middle (Mittel)",
        Hoch: "High (Hoch)",
        "Sehr gut / gut": "Very good / good",
        "Weniger gut / schlecht": "Less good / bad",
        Katholisch: "Catholic",
        Evangelisch: "Protestant",
        Muslimisch: "Muslim",
        Keine: "No religious affiliation",
    };
    let dimension = "age";

    function label(group) {
        return displayNames[group] || group.replace(" / ", " · ");
    }

    function groupsFor(dim) {
        const values = new Map();
        for (const row of data) {
            if (row.dimension === dim) values.set(row.group_label, Number(row.group_order));
        }
        return [...values].sort((a, b) => a[1] - b[1]).map(([group]) => group);
    }

    function setChoices(select, choices) {
        select.replaceChildren();
        for (const value of choices) select.add(new Option(label(value), value));
    }

    function switchDimension(dim) {
        dimension = dim;
        tabs.forEach((tab) => {
            const selected = tab.dataset.dimension === dim;
            tab.classList.toggle("is-selected", selected);
            tab.setAttribute("aria-pressed", String(selected));
        });
        const groups = groupsFor(dim);
        setChoices(selectA, groups);
        setChoices(selectB, groups);
        selectA.value = groups[0];
        selectB.value = groups[groups.length - 1];
        render();
    }

    function rowData(group) {
        return new Map(
            data
                .filter((row) => row.dimension === dimension && row.group_label === group)
                .map((row) => [row.party, row])
        );
    }

    function addBarLine(parent, letter, value, color, group, party) {
        const line = document.createElement("div");
        line.className = "voter-bar-line" + (letter === "B" ? " is-b" : "");
        const id = document.createElement("span");
        id.className = "voter-bar-letter";
        id.textContent = letter;
        const track = document.createElement("div");
        track.className = "voter-bar-track";
        const fill = document.createElement("span");
        fill.className = "voter-bar-fill";
        fill.style.width = `${value}%`;
        fill.style.background = color;
        track.title = `${party}: ${label(group)} — ${value}%`;
        track.appendChild(fill);
        const valueLabel = document.createElement("span");
        valueLabel.className = "voter-bar-value";
        valueLabel.textContent = `${value}%`;
        line.append(id, track, valueLabel);
        parent.appendChild(line);
    }

    function render() {
        const aGroup = selectA.value;
        const bGroup = selectB.value;
        if (!aGroup || !bGroup) return;
        const a = rowData(aGroup),
            b = rowData(bGroup);
        const matching = order.filter((party) => a.has(party) && b.has(party));
        $("voterChartTitle").textContent = `${dimensionNames[dimension]} — party vote shares`;
        $("voterLabelA").textContent = label(aGroup);
        $("voterLabelB").textContent = label(bGroup);
        $("voterPartyCount").textContent = `${matching.length} reported parties`;
        const container = $("voterChartRows");
        container.replaceChildren();
        const gaps = [];
        for (const party of matching) {
            const aValue = Number(a.get(party).vote_share_pct);
            const bValue = Number(b.get(party).vote_share_pct);
            const delta = bValue - aValue;
            gaps.push({ party, delta, magnitude: Math.abs(delta) });
            const row = document.createElement("div");
            row.className = "voter-party-row";
            const partyLabel = document.createElement("div");
            partyLabel.className = "voter-party-name";
            const dot = document.createElement("i");
            dot.style.background = colors[party];
            const name = document.createElement("span");
            name.textContent = party;
            partyLabel.append(dot, name);
            const bars = document.createElement("div");
            bars.className = "voter-bars";
            addBarLine(bars, "A", aValue, colors[party], aGroup, party);
            addBarLine(bars, "B", bValue, colors[party], bGroup, party);
            const gap = document.createElement("div");
            gap.className = "voter-party-gap";
            gap.textContent = `${delta > 0 ? "+" : ""}${delta}`;
            const unit = document.createElement("small");
            unit.textContent = "pp";
            gap.appendChild(unit);
            row.append(partyLabel, bars, gap);
            container.appendChild(row);
        }
        gaps.sort((x, y) => y.magnitude - x.magnitude || order.indexOf(x.party) - order.indexOf(y.party));
        const insight = $("voterInsight");
        insight.replaceChildren();
        const text = document.createElement("p");
        if (aGroup === bGroup) {
            text.textContent = "Both selections are the same group. Choose another group to compare voting patterns.";
        } else {
            const biggest = gaps[0];
            const higher = biggest.delta > 0 ? label(bGroup) : label(aGroup);
            if (biggest.magnitude === 0) {
                text.textContent =
                    "The displayed parties have identical rounded vote-share estimates in both selected groups.";
            } else {
                text.textContent = `The largest numerical gap among the parties shown is ${biggest.magnitude} percentage points for ${biggest.party}, with the higher estimate in ${higher}. This is a descriptive comparison, not evidence of a causal effect or a statistical significance test.`;
            }
        }
        insight.appendChild(text);
        $("voterMethod").textContent =
            notes[dimension] +
            " Percentages are rounded, and the published tables exclude some parties. Results describe Berlin-wide respondents, not the geographic area currently selected on the map.";
        const source = a.values().next().value;
        const page = source.source_page ? `, page ${source.source_page}` : "";
        $("voterSourceName").textContent = `${source.source}${page}`;
        $("voterSourceLink").href = source.source_url;
    }

    function init() {
        if (!Array.isArray(data) || data.length !== 197) {
            throw new Error(
                "The offline voter-group dataset is missing or incomplete (expected 197 estimates). Check data/berlin_2026_voter_groups.js."
            );
        }
        const dims = new Set(Object.keys(dimensionNames));
        const grouped = new Map();
        for (const row of data) {
            if (
                !dims.has(row.dimension) ||
                !row.group_label ||
                !row.party ||
                !Number.isFinite(Number(row.vote_share_pct)) ||
                Number(row.vote_share_pct) < 0 ||
                Number(row.vote_share_pct) > 100 ||
                !row.source_url
            )
                throw new Error("Invalid demographic dataset record.");
            const key = row.dimension + "|" + row.group_label;
            if (!grouped.has(key)) grouped.set(key, new Set());
            if (grouped.get(key).has(row.party)) throw new Error("Duplicate demographic group and party.");
            grouped.get(key).add(row.party);
        }
        if (grouped.size !== 29) throw new Error("Unexpected number of demographic groups.");
        tabs.forEach((tab) => tab.addEventListener("click", () => switchDimension(tab.dataset.dimension)));
        selectA.addEventListener("change", render);
        selectB.addEventListener("change", render);
        switchDimension("age");
        status.textContent = "197 survey estimates across six voter characteristics loaded automatically.";
    }

    try {
        init();
    } catch (error) {
        console.error("Voter explorer:", error);
        status.textContent = error.message;
        status.classList.add("error");
    }
})();

// --------------------------------------------------
// Food Atlas-style dropdowns (no HTML changes needed)
// --------------------------------------------------
(() => {
    const ids = ["mapMode", "partySelect", "voterGroupA", "voterGroupB"];
    const pickers = [];

    function closePicker(picker) {
        picker.classList.remove("is-open");
        picker.querySelector(".atlas-dropdown-trigger").setAttribute("aria-expanded", "false");
        picker.querySelector(".atlas-dropdown-menu").hidden = true;
    }

    function closeOthers(current) {
        for (const picker of pickers) {
            if (picker !== current) closePicker(picker);
        }
    }

    for (const id of ids) {
        const select = document.getElementById(id);
        if (!select || select.dataset.atlasEnhanced === "true") continue;

        const picker = document.createElement("div");
        picker.className = "atlas-dropdown";

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "atlas-dropdown-trigger";
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");
        trigger.setAttribute("aria-controls", `atlas-menu-${id}`);
        trigger.setAttribute("aria-label", document.querySelector(`label[for="${id}"]`)?.textContent.trim() || id);

        const current = document.createElement("span");
        current.className = "atlas-dropdown-current";
        const arrow = document.createElement("span");
        arrow.className = "atlas-dropdown-arrow";
        arrow.setAttribute("aria-hidden", "true");
        trigger.append(current, arrow);

        const menu = document.createElement("div");
        menu.className = "atlas-dropdown-menu";
        menu.id = `atlas-menu-${id}`;
        menu.setAttribute("role", "menu");
        menu.hidden = true;

        picker.append(trigger, menu);
        select.insertAdjacentElement("afterend", picker);
        pickers.push(picker);

        function sync() {
            current.textContent = select.selectedOptions[0]?.textContent.trim() || "Select an option";
            for (const button of menu.querySelectorAll(".atlas-dropdown-option")) {
                const selected = button.dataset.value === select.value;
                button.classList.toggle("is-selected", selected);
                button.setAttribute("aria-checked", String(selected));
            }
        }

        function close() {
            closePicker(picker);
        }

        function open() {
            closeOthers(picker);
            picker.classList.add("is-open");
            menu.hidden = false;
            trigger.setAttribute("aria-expanded", "true");
        }

        function rebuild() {
            const fragment = document.createDocumentFragment();
            for (const option of select.options) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "atlas-dropdown-option";
                button.dataset.value = option.value;
                button.textContent = option.textContent;
                button.setAttribute("role", "menuitemradio");
                button.disabled = option.disabled;
                button.addEventListener("click", () => {
                    select.value = option.value;
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                    sync();
                    close();
                    trigger.focus();
                });
                fragment.appendChild(button);
            }
            menu.replaceChildren(fragment);
            sync();
        }

        function focusOption(which = "selected") {
            const options = [...menu.querySelectorAll(".atlas-dropdown-option:not(:disabled)")];
            if (!options.length) return;
            let index = options.findIndex((b) => b.dataset.value === select.value);
            if (which === "first") index = 0;
            if (which === "last") index = options.length - 1;
            options[Math.max(index, 0)].focus();
        }

        trigger.addEventListener("click", () => {
            if (picker.classList.contains("is-open")) close();
            else open();
        });

        trigger.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && picker.classList.contains("is-open")) {
                event.preventDefault();
                close();
                return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            open();
            focusOption(event.key === "ArrowDown" ? "first" : "last");
        });

        menu.addEventListener("keydown", (event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "Escape") {
                close();
                trigger.focus();
                return;
            }
            const options = [...menu.querySelectorAll(".atlas-dropdown-option:not(:disabled)")];
            if (!options.length) return;
            const index = options.indexOf(document.activeElement);
            let next = index;
            if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else if (event.key === "ArrowDown") next = (index + 1) % options.length;
            else next = (index - 1 + options.length) % options.length;
            options[next].focus();
        });

        select.addEventListener("change", sync);
        new MutationObserver(rebuild).observe(select, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        rebuild();
        select.classList.add("atlas-native-select");
        select.tabIndex = -1;
        select.setAttribute("aria-hidden", "true");
        select.dataset.atlasEnhanced = "true";
    }

    document.addEventListener("pointerdown", (event) => {
        for (const picker of pickers) {
            if (!picker.contains(event.target)) closePicker(picker);
        }
    });

    document.addEventListener("focusin", (event) => {
        for (const picker of pickers) {
            if (!picker.contains(event.target)) closePicker(picker);
        }
    });
})();
