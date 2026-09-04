/* Graphical code-graph runtime. No dependencies. Expects window.GRAPHICAL_CODE_GRAPH. */
(function () {
    "use strict";

    var ICONS = {
        polyline:
            "M620-80v-95L310-330H120v-220h175l125-140v-190h220v220H474L340-510v129l280 139v-58h220v220H620ZM480-720h100v-100H480v100ZM180-390h100v-100H180v100Zm500 250h100v-100H680v100ZM530-770ZM230-440Zm500 250Z",
        anchor: "M349.5-104Q285-128 234-167t-82.5-88Q120-304 120-355v-100l135 101-58 58q31 58 106 103.5T450-142v-388H320v-60h130v-74q-38-14-59-42t-21-64q0-46 32.5-78t77.5-32q46 0 78 32t32 78q0 36-21 64t-59 42v74h130v60H510v388q72-5 147-50.5T763-296l-58-58 135-101v100q0 51-31.5 100T726-167q-51 39-115.5 63T480-80q-66 0-130.5-24ZM480-720q21 0 35.5-15t14.5-35q0-21-14.5-35.5T480-820q-20 0-35 14.5T430-770q0 20 15 35t35 15Z",
        align_horizontal_left:
            "M80-80v-800h60v800H80Zm160-210v-100h400v100H240Zm0-280v-100h640v100H240Z",
        square_foot:
            "M200-120q-33 0-56.5-23.5T120-200v-539q0-37 34.5-51t61.5 13l45 45-42 42 27 27 42-42 117 117-42 42 27 27 42-42 118 118-42 42 27 27 42-42 117 117-42 42 27 27 42-42 45 45q30 30 15 68.5T726-120H200Zm0-80h463L200-663v463Z",
        space_bar: "M160-360v-240h60v180h520v-180h60v240H160Z",
        alt_route:
            "M450-80v-200q0-48-16-79t-49-64l43-43q13 11 27.5 30t24.5 35q17-26 33.5-45t31.5-32q58-47 83.5-113.5T648-766l-90 90-42-42 162-162 162 162-42 42-90-90q5 126-24.5 198.5T585-432q-44 40-59.5 73T510-280v200h-60ZM258-636q-4-18-6.5-52.5T251-765l-89 89-42-42 162-162 162 162-42 42-90-90q-2 38-1 66.5t5 49.5l-58 14Zm84 171q-17-18-37.5-47.5T273-577l59-15q9 25 24 48t28 37l-42 42Z",
        block: "M324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM480-140q61.01 0 117.51-20.5Q654-181 699-220L220-699q-38 46-59 102.17T140-480q0 142.37 98.81 241.19Q337.63-140 480-140Zm259-121q37-45 59-101.49 22-56.5 22-117.51 0-142.38-98.81-241.19T480-820q-60.66 0-116.83 21T261-739l478 478ZM480-480Z",
        swipe: "M470-80q-21.88 0-41.94-8T392-112L184-320l15-22q11-16 28.5-22.5T264-366l96 26v-340q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v420l-124-33 139.18 139.18Q442-147 451.13-143.5q9.13 3.5 18.87 3.5h170q42 0 71-29t29-71v-180q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v180q0 66-47 113T640-80H470Zm17-290v-170q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v170h-60Zm126 0v-130q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v130h-60Zm-46 105Zm313-435H700v-40h133q-75-65-164.5-102.5T480-880q-99 0-188.5 37.5T127-740h133v40H80v-180h40v93q78-62 169-97.5T480-920q100 0 191 35.5T840-787v-93h40v180Z",
        keyboard:
            "M140-200q-24 0-42-18.5T80-260v-440q0-24 18-42t42-18h680q24 0 42 18t18 42v440q0 23-18 41.5T820-200H140Zm0-60h680v-440H140v440Zm160-65h360v-60H300v60Zm-97-125h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60ZM203-575h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60ZM140-260v-440 440Z",
        swap_horiz:
            "M273-160 80-353l193-193 42 42-121 121h316v60H194l121 121-42 42Zm414-254-42-42 121-121H450v-60h316L645-758l42-42 193 193-193 193Z",
        commit:
            "M352.5-325.5Q298-371 284-440H80v-80h204q14-69 68.5-114.5T480-680q73 0 127.5 45.5T676-520h204v80H676q-14 69-68.5 114.5T480-280q-73 0-127.5-45.5ZM479.76-340Q538-340 579-380.76q41-40.77 41-99Q620-538 579.24-579q-40.77-41-99-41Q422-620 381-579.24q-41 40.77-41 99Q340-422 380.76-381q40.77 41 99 41Z",
        account_tree:
            "M604-120v-125H450v-410h-93v130H80v-315h277v125h247v-125h276v315H604v-130h-94v350h94v-130h276v315H604ZM140-780v195-195Zm524 405v195-195Zm0-405v195-195Zm0 195h156v-195H664v195Zm0 405h156v-195H664v195ZM140-585h157v-195H140v195Z",
        memory:
            "M377-377v-205h205v205H377Zm60-60h85v-85h-85v85Zm-77 317v-80H260q-24 0-42-18t-18-42v-100h-80v-60h80v-124h-80v-60h80v-100q0-24 18-42t42-18h100v-76h60v76h124v-76h60v76h100q24 0 42 18t18 42v100h76v60h-76v124h76v60h-76v100q0 24-18 42t-42 18H604v80h-60v-80H420v80h-60Zm344-140v-444H260v444h444ZM480-480Z",
        brush: "M215-117q-33.83 0-66.92-11.5Q115-140 90-166q35-12 50-35t15-62q0-43.75 30.68-74.38Q216.35-368 260.18-368q43.82 0 74.32 30.62Q365-306.75 365-263q0 64-43.5 105T215-117Zm0-60q35 0 62.5-25t27.5-61q0-20-12.5-32.5T260-308q-20 0-32.5 12.5T215-263q0 39-8.5 57.5T175-183q6 1 20 3.5t20 2.5Zm230-177-90-95 376-376q14-14 31-14.5t32 14.5l29 29q15 15 14.5 32.5T823-732L445-354Zm-185 91Z",
        manufacturing:
            "m229-496-6-49q-20-5-37.5-14.5T154-583l-44 18-30-49 37-35q-5-20-5-39t5-39l-37-35 30-49 44 18q14-14 31.5-23.5T223-831l6-49h60l6 49q20 5 37.5 14.5T364-793l44-18 30 49-38 35q5 19 5 38.5t-5 39.5l38 35-30 49-44-18q-14 15-31.5 24T295-545l-6 49h-60Zm95-127q27-27 27-65t-27-65q-27-27-65-27t-65 27q-27 27-27 65t27 65q27 27 65 27t65-27ZM644-40l-14-57q-27-7-51.5-21T536-154l-54 17-38-65 42-38q-8-26-8-54t8-54l-42-37 38-65 54 15q19-21 43-35.5t51-20.5l14-57h75l14 57q29 4 52.5 19t42.5 37l54-15 38 65-42 37q8 26 8 54t-8 54l42 38-38 66-54-18q-18 23-42.5 36.5T733-97l-14 57h-75Zm38-115q58 0 98.5-40.5T821-294q0-58-40.5-98.5T682-433q-58 0-98.5 40.5T543-294q0 58 40.5 98.5T682-155Z",
        speed: "M473.5-303.5Q517-305 537-336l216-339-335 219q-30 20-32 64t21 67q23 23 66.5 21.5ZM478-799q57 0 119 18.5T716-717l-52 37q-45-30-96.5-44.5T477.98-739q-140.47 0-239.23 100.22Q140-538.57 140-396.02 140-351 152.5-305q12.5 46 35.5 85h579q22-36 35-84t13-94q0-42-12.5-90.5T758-578l39-52q38 56 57 112.5T875-404q2 60-12 113t-41 98q-12 23-25.5 28t-33.5 5H192q-17 0-33.5-8.5T134-193q-26-48-40-97.5T80-396q0-83 31.5-156.5t85.5-128Q251-735 323.68-767T478-799Zm-9 331Z",
        bolt: "M440-80v-400H280l320-400v400h160L440-80Z",
        filter_list:
            "M400-240v-80h160v80H400ZM240-440v-80h480v80H240ZM120-640v-80h720v80H120Z",
        sync_alt:
            "M280-160 80-360l200-200 56 56-103 104h287v80H233l103 104-56 56Zm400-240-56-56 103-104H440v-80h287L624-744l56-56 200 200-200 200Z",
        laptop:
            "M80-160v-80h800v80H80Zm80-120q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H160Zm0-80h640v-400H160v400Zm0 0v-400 400Z"
    };

    var UNIFY_LABEL = { delete: "DEL", combine: "CMB", remove: "RM" };
    var NS = "http://www.w3.org/2000/svg";
    var COLOR = {
        red: "var(--red)",
        blue: "var(--blue)",
        orange: "var(--orange)",
        green: "var(--green)",
        cyan: "var(--cyan)",
        purple: "var(--purple)",
        pink: "var(--pink)",
        yellow: "var(--yellow)",
        gray: "var(--gray)"
    };

    function el(name, attrs, parent) {
        var node = document.createElement(name);
        if (attrs) {
            Object.keys(attrs).forEach(function (key) {
                if (key === "text") {
                    node.textContent = attrs[key];
                } else if (key === "html") {
                    node.innerHTML = attrs[key];
                } else if (attrs[key] != null) {
                    node.setAttribute(key, attrs[key]);
                }
            });
        }
        if (parent) {
            parent.appendChild(node);
        }
        return node;
    }

    function svgEl(name, attrs, parent) {
        var node = document.createElementNS(NS, name);
        if (attrs) {
            Object.keys(attrs).forEach(function (key) {
                if (key === "text") {
                    node.textContent = attrs[key];
                } else if (attrs[key] != null && attrs[key] !== false) {
                    node.setAttribute(key, String(attrs[key]));
                }
            });
        }
        if (parent) {
            parent.appendChild(node);
        }
        return node;
    }

    function lastOf(lane) {
        return lane.nodes[lane.nodes.length - 1];
    }

    function matchRecord(item, pred) {
        if (!pred) {
            return false;
        }
        return Object.keys(pred).every(function (key) {
            if (key === "unify") {
                return item.unify && item.unify.action === pred.unify;
            }
            if (key === "mark") {
                return false;
            }
            return item[key] === pred[key];
        });
    }

    function computeGeom(graph) {
        var L = graph.layout;
        var chipW = L.chipW;
        var chipH = L.chipH;
        var colGap = L.colGap;
        var rowGap = L.rowGap;
        var originX = L.originX;
        var originY = L.originY;
        var storyCols = L.storyCols;
        var storyRows = L.storyRows;
        var compilingRows = L.compilingRows;
        var chokeGap = L.chokeGap;
        var compileW = L.sink.w;
        var compileH = L.sink.hSlots * chipH + (L.sink.hSlots - 1) * rowGap;
        var stageW = storyCols * chipW + (storyCols - 1) * colGap;
        var bridgeX = originX + stageW + colGap;
        var filterX = bridgeX + chipW + colGap;
        var storyW = filterX + chipW - originX;
        var funnelX = filterX + chipW + chokeGap;
        var compileX = funnelX + chipW + colGap;
        var evCompiledX = compileX + compileW + colGap;
        var canvasX = evCompiledX + chipW + colGap;
        var compilingH = compilingRows * chipH + (compilingRows - 1) * rowGap;
        var funnelY0 = originY + Math.round((compilingH - compileH) / 2);
        var bridgeCount = graph.nodes.filter(function (n) {
            return n.region === "bridge";
        }).length;
        var bridgeStackH = Math.max(
            chipH,
            bridgeCount * chipH + Math.max(0, bridgeCount - 1) * rowGap
        );
        var bridgeY0 = funnelY0 + Math.round((compileH - bridgeStackH) / 2);
        var consumeNodes = graph.nodes.filter(function (n) {
            return n.canvasIndex != null;
        });
        var consumeStackH =
            consumeNodes.length * chipH +
            Math.max(0, consumeNodes.length - 1) * rowGap;
        var canvasY0 = funnelY0 + Math.round((compileH - consumeStackH) / 2);
        var storyBottom = originY + storyRows * (chipH + rowGap) - rowGap;
        var renderY = canvasY0 + consumeStackH + rowGap;
        var footerY = Math.max(storyBottom, renderY + chipH) + 48;
        return {
            chipW: chipW,
            chipH: chipH,
            colGap: colGap,
            rowGap: rowGap,
            originX: originX,
            originY: originY,
            storyCols: storyCols,
            storyRows: storyRows,
            filterCol: L.filterCol,
            storyW: storyW,
            bridgeX: bridgeX,
            filterX: filterX,
            funnelX: funnelX,
            compileX: compileX,
            compileW: compileW,
            compileH: compileH,
            evCompiledX: evCompiledX,
            canvasX: canvasX,
            funnelY0: funnelY0,
            bridgeY0: bridgeY0,
            bridgeStackH: bridgeStackH,
            canvasY0: canvasY0,
            consumeStackH: consumeStackH,
            renderY: renderY,
            footerY: footerY,
            rustStartX: funnelX,
            viewW: canvasX + chipW + 20,
            viewH: footerY + chipH + 24,
            railLive: funnelX - 48,
            railKey: funnelX - 32,
            railCommit: funnelX - 16,
            sinkId: L.sink.id,
            compiledId: L.compiledId,
            renderedId: L.renderedId,
            accentCol: L.accentCol
        };
    }

    function placeNode(node, g) {
        var box = Object.assign({}, node);
        if (node.id === g.compiledId) {
            box.x = g.evCompiledX;
            box.y = g.funnelY0 + Math.round((g.compileH - g.chipH) / 2);
            box.w = g.chipW;
            box.h = g.chipH;
            return box;
        }
        if (node.id === g.renderedId) {
            box.x = g.canvasX;
            box.y = g.renderY;
            box.w = g.chipW;
            box.h = g.chipH;
            return box;
        }
        if (node.region === "story") {
            box.x =
                node.col === g.filterCol
                    ? g.filterX
                    : g.originX + (node.col || 0) * (g.chipW + g.colGap);
            box.y = g.originY + (node.row || 0) * (g.chipH + g.rowGap);
            box.w = g.chipW;
            box.h = g.chipH;
            return box;
        }
        if (node.region === "bridge") {
            box.x = g.bridgeX;
            box.y = g.bridgeY0 + (node.bridgeIndex || 0) * (g.chipH + g.rowGap);
            box.w = g.chipW;
            box.h = g.chipH;
            return box;
        }
        if (node.region === "choke" && node.id === g.sinkId) {
            box.x = g.compileX;
            box.y = g.funnelY0;
            box.w = g.compileW;
            box.h = g.compileH;
            return box;
        }
        if (node.region === "choke") {
            box.x = g.funnelX;
            box.y = g.funnelY0 + (node.funnelIndex || 0) * (g.chipH + g.rowGap);
            box.w = g.chipW;
            box.h = g.chipH;
            return box;
        }
        if (node.region === "consume") {
            box.x = g.canvasX;
            box.y = g.canvasY0 + (node.canvasIndex || 0) * (g.chipH + g.rowGap);
            box.w = g.chipW;
            box.h = g.chipH;
            return box;
        }
        box.x = g.rustStartX + (node.rustIndex || 0) * (g.chipW + g.colGap);
        box.y = g.footerY;
        box.w = g.chipW;
        box.h = g.chipH;
        return box;
    }

    function spread(y0, h, count, index) {
        var pad = Math.min(14, h / 5);
        if (count <= 1) {
            return y0 + h / 2;
        }
        return y0 + pad + (index * (h - 2 * pad)) / (count - 1);
    }

    function startTriangle(cx, cy, r) {
        return (
            "M " +
            (cx - r * 0.55) +
            " " +
            (cy - r) +
            " L " +
            (cx + r) +
            " " +
            cy +
            " L " +
            (cx - r * 0.55) +
            " " +
            (cy + r) +
            " Z"
        );
    }

    function octagonPath(cx, cy, r) {
        var k = r * 0.42;
        var pts = [
            [cx - k, cy - r],
            [cx + k, cy - r],
            [cx + r, cy - k],
            [cx + r, cy + k],
            [cx + k, cy + r],
            [cx - k, cy + r],
            [cx - r, cy + k],
            [cx - r, cy - k]
        ];
        return (
            "M " +
            pts
                .map(function (p) {
                    return p.join(" ");
                })
                .join(" L ") +
            " Z"
        );
    }

    function edgePath(edge, from, to, yFrom, yTo, g) {
        var x1 = from.x + from.w;
        var x2 = to.x;
        var route = edge.route;
        if (route === "row" || route === "choke") {
            if (Math.abs(yFrom - yTo) < 1) {
                return "M " + x1 + " " + yFrom + " H " + x2;
            }
            var mid = Math.round((x1 + x2) / 2);
            return (
                "M " + x1 + " " + yFrom + " H " + mid + " V " + yTo + " H " + x2
            );
        }
        if (route === "south") {
            var ySouth = from.y + from.h + 10;
            return (
                "M " +
                (from.x + from.w / 2) +
                " " +
                (from.y + from.h) +
                " V " +
                ySouth +
                " H " +
                (to.x - 12) +
                " V " +
                yTo +
                " H " +
                x2
            );
        }
        if (route === "north") {
            var north = from.y - 12;
            return (
                "M " +
                x1 +
                " " +
                (from.y + from.h / 2) +
                " H " +
                (x1 + 10) +
                " V " +
                north +
                " H " +
                (to.x - 12) +
                " V " +
                yTo +
                " H " +
                x2
            );
        }
        if (route === "live" || route === "key" || route === "commit") {
            var rail =
                route === "live"
                    ? g.railLive
                    : route === "key"
                      ? g.railKey
                      : to.region === "bridge"
                        ? g.bridgeX - 16
                        : g.railCommit;
            if (route === "commit") {
                if (from.region === "bridge" && to.region === "choke") {
                    var gapY = from.y - 12;
                    return (
                        "M " +
                        x1 +
                        " " +
                        (from.y + from.h / 2) +
                        " V " +
                        gapY +
                        " H " +
                        rail +
                        " V " +
                        yTo +
                        " H " +
                        x2
                    );
                }
                return (
                    "M " +
                    x1 +
                    " " +
                    (from.y + from.h / 2) +
                    " H " +
                    rail +
                    " V " +
                    yTo +
                    " H " +
                    x2
                );
            }
            return (
                "M " +
                x1 +
                " " +
                (from.y + from.h / 2) +
                " H " +
                (x1 + 10) +
                " V " +
                (from.y - 12) +
                " H " +
                rail +
                " V " +
                yTo +
                " H " +
                x2
            );
        }
        if (route === "fan") {
            var fanMid = Math.round((x1 + x2) / 2);
            return (
                "M " + x1 + " " + yFrom + " H " + fanMid + " V " + yTo + " H " + x2
            );
        }
        if (route === "down") {
            var yMid = to.y - 16;
            return (
                "M " +
                (from.x + from.w / 2) +
                " " +
                (from.y + from.h) +
                " V " +
                yMid +
                " H " +
                (to.x + to.w / 2) +
                " V " +
                to.y
            );
        }
        if (route === "leak") {
            var yLeak = from.y + from.h + 16;
            return (
                "M " +
                (from.x + from.w / 2) +
                " " +
                (from.y + from.h) +
                " V " +
                yLeak +
                " H " +
                (to.x + to.w / 2) +
                " V " +
                (to.y + to.h)
            );
        }
        var dropY = g.footerY - 18;
        return (
            "M " +
            (from.x + from.w / 2) +
            " " +
            (from.y + from.h) +
            " V " +
            dropY +
            " H " +
            (to.x + to.w / 2) +
            " V " +
            to.y
        );
    }

    function nodeVisible(node, view) {
        if (!view || view.id === "all") {
            return true;
        }
        if (view.hideIds && view.hideIds.indexOf(node.id) !== -1) {
            return false;
        }
        if (view.unifyOnly) {
            return Boolean(node.unify) || (view.alsoIds || []).indexOf(node.id) !== -1;
        }
        if (view.any) {
            return view.any.some(function (pred) {
                return matchRecord(node, pred);
            });
        }
        if (view.stages) {
            return view.stages.indexOf(node.stage) !== -1;
        }
        return true;
    }

    function fillFor(node, g) {
        if (node.kind === "unused") {
            return "var(--fill-3)";
        }
        if (node.kind === "alias" || node.stage === "scatter") {
            return "var(--fill-1)";
        }
        if (node.stage === "event" || node.stage === "filter") {
            return "var(--fill-4)";
        }
        if (node.id === g.sinkId || node.region === "choke" || node.region === "bridge") {
            return "var(--fill-2)";
        }
        return "var(--bg-elevated)";
    }

    function unifyFill(action) {
        if (action === "delete") {
            return "var(--red)";
        }
        if (action === "combine") {
            return "var(--blue)";
        }
        return "var(--orange)";
    }

    function GraphicalCodeGraph(graph, mount) {
        var geom = computeGeom(graph);
        var placed = graph.nodes.map(function (node) {
            return placeNode(node, geom);
        });
        var byId = {};
        placed.forEach(function (node) {
            byId[node.id] = node;
        });
        var incoming = {};
        var outgoing = {};
        graph.edges.forEach(function (edge) {
            (incoming[edge.to] || (incoming[edge.to] = [])).push(edge);
            (outgoing[edge.from] || (outgoing[edge.from] = [])).push(edge);
        });

        var state = { viewId: (graph.views[0] && graph.views[0].id) || "all", hover: null };
        var edgeEls = [];
        var nodeEls = {};

        function lanesThrough(id) {
            return graph.lanes.filter(function (lane) {
                return lane.nodes.indexOf(id) !== -1;
            });
        }

        function hoverLanes() {
            if (!state.hover || state.hover.kind !== "node") {
                return null;
            }
            return lanesThrough(state.hover.id);
        }

        function startVisible(nodeId) {
            var lanes = hoverLanes();
            if (!lanes || !lanes.length) {
                return false;
            }
            if (
                !lanes.every(function (lane) {
                    return lane.nodes[0] === nodeId;
                })
            ) {
                return false;
            }
            var node = byId[nodeId];
            var origin = lanes[0].origin || "canvas";
            if (
                !lanes.every(function (lane) {
                    return (lane.origin || "canvas") === origin;
                })
            ) {
                return false;
            }
            if (node.originRole) {
                return node.originRole === origin;
            }
            return origin !== "remote";
        }

        function stopVisible(nodeId) {
            var lanes = hoverLanes();
            if (!lanes || !lanes.length) {
                return false;
            }
            var touching = lanes.filter(function (lane) {
                return lane.nodes.indexOf(nodeId) !== -1;
            });
            return (
                touching.length > 0 &&
                touching.every(function (lane) {
                    return lastOf(lane) === nodeId;
                })
            );
        }

        function mixedTerminus(id) {
            var lanes = lanesThrough(id);
            var stops = lanes.filter(function (lane) {
                return lastOf(lane) === id;
            });
            var continues = lanes.filter(function (lane) {
                return lastOf(lane) !== id;
            });
            if (stops.length && continues.length) {
                return { stops: stops, continues: continues };
            }
            return null;
        }

        function legendItemMatchesNode(item, node) {
            if (!item.node) {
                return false;
            }
            if (item.node.mark === "start") {
                return startVisible(node.id);
            }
            if (item.node.mark === "stop") {
                return stopVisible(node.id);
            }
            return matchRecord(node, item.node);
        }

        function legendItemMatchesEdge(item, edge) {
            return item.edge ? matchRecord(edge, item.edge) : false;
        }

        function currentView() {
            return (
                graph.views.filter(function (view) {
                    return view.id === state.viewId;
                })[0] || graph.views[0]
            );
        }

        function laneSet() {
            var hover = state.hover;
            if (hover && hover.kind === "legend") {
                var item = graph.legend.filter(function (entry) {
                    return entry.id === hover.id;
                })[0];
                var ids = {};
                if (!item) {
                    return ids;
                }
                graph.nodes.forEach(function (node) {
                    if (legendItemMatchesNode(item, node)) {
                        ids[node.id] = true;
                    }
                });
                graph.edges.forEach(function (edge) {
                    if (legendItemMatchesEdge(item, edge)) {
                        ids[edge.from] = true;
                        ids[edge.to] = true;
                    }
                });
                return ids;
            }
            if (!hover || hover.kind !== "node") {
                return null;
            }
            var set = {};
            set[hover.id] = true;
            lanesThrough(hover.id).forEach(function (lane) {
                lane.nodes.forEach(function (id) {
                    set[id] = true;
                });
            });
            graph.edges.forEach(function (edge) {
                if (edge.from === hover.id) {
                    set[edge.to] = true;
                }
                if (edge.to === hover.id) {
                    set[edge.from] = true;
                }
            });
            return set;
        }

        function labelOf(id) {
            return byId[id] ? byId[id].label : id;
        }

        function cssColor(name) {
            return COLOR[name] || "var(--gray)";
        }

        mount.innerHTML = "";
        mount.className = "gcg";

        var header = el("header", { class: "gcg-header" }, mount);
        var titleRow = el("div", { class: "gcg-title-row" }, header);
        el("h1", { text: graph.title }, titleRow);
        if (graph.snapshotLabel) {
            el("span", { class: "gcg-pill active sm", text: graph.snapshotLabel }, titleRow);
        }
        if (graph.snapshotId) {
            el("span", { class: "gcg-pill sm", text: graph.snapshotId }, titleRow);
        }
        if (graph.lede) {
            el("p", { class: "gcg-lede", text: graph.lede }, header);
        }
        if (graph.stats && graph.stats.length) {
            var stats = el("div", { class: "gcg-stats" }, header);
            graph.stats.forEach(function (stat) {
                var box = el(
                    "div",
                    { class: "gcg-stat" + (stat.tone === "warning" ? " warn" : "") },
                    stats
                );
                var value =
                    stat.value === "unifyCount"
                        ? String(
                              graph.nodes.filter(function (node) {
                                  return node.unify;
                              }).length
                          )
                        : String(stat.value);
                el("b", { text: value }, box);
                el("span", { text: stat.label }, box);
            });
        }
        if (graph.callout) {
            var callout = el("aside", { class: "gcg-callout" }, header);
            el("strong", { text: graph.callout.title }, callout);
            el("p", { text: graph.callout.body }, callout);
        }

        var viewsRow = el("div", { class: "gcg-views gcg-pills" }, header);
        var viewButtons = {};
        graph.views.forEach(function (view) {
            var btn = el("button", { class: "gcg-pill", type: "button", text: view.label }, viewsRow);
            btn.addEventListener("click", function () {
                state.viewId = view.id;
                paint();
            });
            viewButtons[view.id] = btn;
        });

        var board = el("div", { class: "gcg-board" }, mount);
        var svg = svgEl(
            "svg",
            {
                viewBox: "0 0 " + geom.viewW + " " + geom.viewH,
                width: "100%",
                role: "img",
                "aria-label": graph.title
            },
            board
        );
        svg.addEventListener("mouseleave", function () {
            state.hover = null;
            paint();
        });

        svgEl("rect", { width: geom.viewW, height: geom.viewH, fill: "var(--bg)" }, svg);
        var row;
        for (row = 0; row < geom.storyRows; row += 1) {
            svgEl(
                "rect",
                {
                    x: 4,
                    y: geom.originY + row * (geom.chipH + geom.rowGap) - 8,
                    width: geom.storyW + 20,
                    height: geom.chipH + 16,
                    rx: 8,
                    fill: "var(--fill-3)",
                    opacity: 0.35
                },
                svg
            );
        }
        svgEl(
            "rect",
            {
                x: geom.bridgeX - 12,
                y: geom.bridgeY0 - 28,
                width: geom.chipW + 24,
                height: geom.bridgeStackH + 40,
                rx: 10,
                fill: "var(--fill-2)",
                opacity: 0.45
            },
            svg
        );
        svgEl(
            "rect",
            {
                x: geom.funnelX - 16,
                y: geom.funnelY0 - 32,
                width: geom.chipW + geom.colGap + geom.compileW + geom.colGap + geom.chipW + 32,
                height: geom.compileH + 48,
                rx: 10,
                fill: "var(--fill-2)",
                opacity: 0.45
            },
            svg
        );
        svgEl(
            "rect",
            {
                x: geom.canvasX - 16,
                y: geom.canvasY0 - 32,
                width: geom.chipW + 32,
                height: geom.consumeStackH + geom.rowGap + geom.chipH + 48,
                rx: 10,
                fill: "var(--fill-3)",
                opacity: 0.55
            },
            svg
        );

        (graph.headers || []).forEach(function (headerItem) {
            var x = geom[headerItem.at] != null ? geom[headerItem.at] : geom.originX;
            svgEl(
                "text",
                {
                    x: x,
                    y: headerItem.y,
                    fill: headerItem.weight ? "var(--text-2)" : "var(--text-3)",
                    "font-size": 11,
                    "font-family": "ui-sans-serif, system-ui, sans-serif",
                    "font-weight": headerItem.weight || 400,
                    text: headerItem.text
                },
                svg
            );
        });
        (graph.columnTitles || []).forEach(function (title) {
            var x = geom.originX;
            if (title.at === "filter") {
                x = geom.filterX;
            } else if (typeof title.at === "number") {
                x = geom.originX + title.at * (geom.chipW + geom.colGap);
            } else if (geom[title.at] != null) {
                x = geom[title.at];
            }
            var accent = title.at === geom.accentCol;
            svgEl(
                "text",
                {
                    x: x,
                    y: 42,
                    fill: accent ? "var(--accent)" : "var(--text-3)",
                    "font-size": 11,
                    "font-family": "ui-sans-serif, system-ui, sans-serif",
                    text: title.text
                },
                svg
            );
        });
        svgEl(
            "text",
            {
                x: geom.rustStartX,
                y: geom.footerY - 12,
                fill: "var(--text-3)",
                "font-size": 11,
                "font-family": "ui-sans-serif, system-ui, sans-serif",
                text: graph.footerTitle || ""
            },
            svg
        );

        var defs = svgEl("defs", null, svg);
        function marker(id, fill) {
            var mark = svgEl(
                "marker",
                {
                    id: id,
                    markerWidth: 8,
                    markerHeight: 8,
                    refX: 7,
                    refY: 4,
                    orient: "auto"
                },
                defs
            );
            svgEl("path", { d: "M0 0 L8 4 L0 8 Z", fill: fill }, mark);
        }
        marker("arrow-flow", "var(--stroke)");
        marker("arrow-alias", "var(--accent)");
        marker("arrow-hover", "var(--accent)");

        graph.edges.forEach(function (edge) {
            var path = svgEl(
                "path",
                { fill: "none", "pointer-events": "none" },
                svg
            );
            edgeEls.push({ edge: edge, el: path });
        });

        placed.forEach(function (node) {
            var group = svgEl("g", { style: "cursor:pointer", "data-id": node.id }, svg);
            group.addEventListener("mouseenter", function () {
                state.hover = { kind: "node", id: node.id };
                paint();
            });
            var rect = svgEl("rect", { x: node.x, y: node.y, width: node.w, height: node.h, rx: 6 }, group);
            var badge = null;
            var badgeText = null;
            if (node.unify) {
                badge = svgEl(
                    "rect",
                    {
                        x: node.x + 4,
                        y: node.y - 9,
                        width: 28,
                        height: 14,
                        rx: 3,
                        fill: unifyFill(node.unify.action)
                    },
                    group
                );
                badgeText = svgEl(
                    "text",
                    {
                        x: node.x + 18,
                        y: node.y + 2,
                        "text-anchor": "middle",
                        fill: "var(--text-on)",
                        "font-size": 8,
                        "font-family": "ui-sans-serif, system-ui, sans-serif",
                        "font-weight": 700,
                        "pointer-events": "none",
                        text: UNIFY_LABEL[node.unify.action]
                    },
                    group
                );
            }
            (node.icons || []).forEach(function (icon, index) {
                var nested = svgEl(
                    "svg",
                    {
                        x: node.x + 8 + index * 18,
                        y: node.id === geom.sinkId ? node.y + 16 : node.y + 10,
                        width: 16,
                        height: 16,
                        viewBox: "0 -960 960 960",
                        "pointer-events": "none"
                    },
                    group
                );
                svgEl(
                    "path",
                    {
                        d: ICONS[icon] || "",
                        fill: node.kind === "unused" ? "var(--text-3)" : "var(--text)",
                        class: "gcg-icon"
                    },
                    nested
                );
            });
            var textX =
                node.id === geom.sinkId
                    ? node.x + 10
                    : node.x + 10 + (node.icons || []).length * 18;
            var labelY = node.id === geom.sinkId ? node.y + node.h / 2 : node.y + 24;
            var subY = node.id === geom.sinkId ? labelY + 16 : node.y + 42;
            svgEl(
                "text",
                {
                    x: textX,
                    y: labelY,
                    fill: "var(--text)",
                    "font-size": node.id === geom.sinkId ? 13 : 11,
                    "font-family": "ui-sans-serif, system-ui, sans-serif",
                    "font-weight": 590,
                    "pointer-events": "none",
                    text: node.label
                },
                group
            );
            if (node.sub) {
                svgEl(
                    "text",
                    {
                        x: textX,
                        y: subY,
                        fill: "var(--text-2)",
                        "font-size": 10,
                        "font-family": "ui-sans-serif, system-ui, sans-serif",
                        "pointer-events": "none",
                        text: node.sub
                    },
                    group
                );
            }
            var startMark = svgEl(
                "path",
                {
                    fill: "var(--green)",
                    stroke: "var(--bg)",
                    "stroke-width": 1.2,
                    "pointer-events": "none",
                    visibility: "hidden"
                },
                group
            );
            var stopMark = svgEl(
                "path",
                {
                    fill: "var(--red)",
                    stroke: "var(--bg)",
                    "stroke-width": 1.2,
                    "pointer-events": "none",
                    visibility: "hidden"
                },
                group
            );
            var stopBar = svgEl(
                "rect",
                {
                    x: node.x + node.w - 6.5,
                    y: node.y + node.h / 2 - 1.4,
                    width: 9,
                    height: 2.8,
                    rx: 0.6,
                    fill: "var(--text-on)",
                    "pointer-events": "none",
                    visibility: "hidden"
                },
                group
            );
            nodeEls[node.id] = {
                node: node,
                group: group,
                rect: rect,
                startMark: startMark,
                stopMark: stopMark,
                stopBar: stopBar,
                badge: badge,
                badgeText: badgeText
            };
        });

        var legendWrap = el("div", { class: "gcg-legend" }, mount);
        var legendButtons = {};
        graph.legend.forEach(function (item) {
            var btn = el("span", { class: "gcg-legend-item" }, legendWrap);
            el("span", { class: "gcg-swatch", style: "background:" + cssColor(item.color) }, btn);
            el("span", { text: item.label }, btn);
            btn.addEventListener("mouseenter", function () {
                state.hover = { kind: "legend", id: item.id };
                paint();
            });
            btn.addEventListener("mouseleave", function () {
                state.hover = null;
                paint();
            });
            legendButtons[item.id] = btn;
        });

        var details = el("section", { class: "gcg-details" }, mount);
        var later = null;
        if (graph.later) {
            later = el("section", { class: "gcg-later" }, mount);
            el("h2", { text: graph.later.title || "Later comparison target" }, later);
            el("p", { text: graph.later.body }, later);
            if (graph.later.hint) {
                el("p", { class: "gcg-hint", text: graph.later.hint }, later);
            }
        }

        function paint() {
            var view = currentView();
            var hover = state.hover;
            var ids = laneSet();
            var hoveredId = hover && hover.kind === "node" ? hover.id : null;
            var legend =
                hover && hover.kind === "legend"
                    ? graph.legend.filter(function (item) {
                          return item.id === hover.id;
                      })[0]
                    : null;

            Object.keys(viewButtons).forEach(function (id) {
                viewButtons[id].classList.toggle("active", id === state.viewId);
            });

            edgeEls.forEach(function (entry) {
                var edge = entry.edge;
                var from = byId[edge.from];
                var to = byId[edge.to];
                if (!from || !to) {
                    return;
                }
                var ins = (incoming[edge.to] || []).filter(function (item) {
                    return item.route === edge.route;
                });
                var outs = (outgoing[edge.from] || []).filter(function (item) {
                    return item.route === edge.route;
                });
                var yFrom = from.y + from.h / 2;
                var yTo = to.y + to.h / 2;
                if (edge.route === "fan") {
                    yFrom = spread(from.y, from.h, outs.length, outs.indexOf(edge));
                }
                if (edge.route === "live" || edge.route === "key" || edge.route === "commit") {
                    yTo = spread(to.y, to.h, ins.length, ins.indexOf(edge));
                }
                var filterOn = nodeVisible(from, view) && nodeVisible(to, view);
                var legendEdge = Boolean(legend && legendItemMatchesEdge(legend, edge));
                var direct =
                    hoveredId != null && (edge.from === hoveredId || edge.to === hoveredId);
                var inLane = ids != null && ids[edge.from] && ids[edge.to];
                var active = hover ? (legend ? legendEdge || inLane : direct || inLane) : filterOn;
                var alias = edge.kind === "alias";
                var dashed = alias || edge.kind === "skip" || edge.kind === "unused";
                var opacity = hover
                    ? direct || legendEdge
                        ? 1
                        : inLane
                          ? 0.85
                          : 0.07
                    : filterOn
                      ? 0.9
                      : 0.1;
                entry.el.setAttribute("d", edgePath(edge, from, to, yFrom, yTo, geom));
                entry.el.setAttribute(
                    "stroke",
                    direct || legendEdge || alias ? "var(--accent)" : "var(--stroke)"
                );
                entry.el.setAttribute("stroke-width", direct || legendEdge ? "3" : active ? "2.25" : "1");
                if (dashed) {
                    entry.el.setAttribute("stroke-dasharray", "7 5");
                } else {
                    entry.el.removeAttribute("stroke-dasharray");
                }
                entry.el.setAttribute("opacity", String(opacity));
                if (active) {
                    entry.el.setAttribute(
                        "marker-end",
                        direct || alias || legendEdge ? "url(#arrow-hover)" : "url(#arrow-flow)"
                    );
                } else {
                    entry.el.removeAttribute("marker-end");
                }
            });

            placed.forEach(function (node) {
                var rec = nodeEls[node.id];
                var filterOn = nodeVisible(node, view);
                var inLane = ids == null || ids[node.id];
                var isHover = hoveredId === node.id;
                var legendHit = Boolean(legend && legendItemMatchesNode(legend, node));
                var show = hover ? inLane && filterOn : filterOn;
                rec.group.setAttribute("opacity", show ? "1" : "0.12");
                rec.rect.setAttribute("fill", fillFor(node, geom));
                var stroke = "var(--stroke-muted)";
                var sw = "1";
                if (isHover || legendHit) {
                    stroke = "var(--accent)";
                    sw = "2.4";
                } else if (node.kind === "alias" || node.stage === "scatter") {
                    stroke = "var(--accent)";
                    sw = "1.6";
                } else if (node.id === geom.sinkId) {
                    stroke = "var(--stroke)";
                    sw = "1.8";
                }
                rec.rect.setAttribute("stroke", stroke);
                rec.rect.setAttribute("stroke-width", sw);
                var showStart = startVisible(node.id);
                var showStop = stopVisible(node.id);
                rec.startMark.setAttribute(
                    "d",
                    startTriangle(node.x + 2, node.y + node.h / 2, 8)
                );
                rec.startMark.setAttribute("visibility", showStart ? "visible" : "hidden");
                rec.stopMark.setAttribute(
                    "d",
                    octagonPath(node.x + node.w - 2, node.y + node.h / 2, 9)
                );
                rec.stopMark.setAttribute("visibility", showStop ? "visible" : "hidden");
                rec.stopBar.setAttribute("visibility", showStop ? "visible" : "hidden");
            });

            var activeLegend = {};
            if (hover && hover.kind === "legend") {
                activeLegend[hover.id] = true;
            } else if (hover && hover.kind === "node") {
                var node = byId[hover.id];
                graph.legend.forEach(function (item) {
                    if (legendItemMatchesNode(item, node)) {
                        activeLegend[item.id] = true;
                    }
                });
                if (startVisible(hover.id)) {
                    activeLegend.start = true;
                }
                if (stopVisible(hover.id)) {
                    activeLegend.stop = true;
                }
                graph.edges.forEach(function (edge) {
                    if (edge.from === hover.id || edge.to === hover.id) {
                        graph.legend.forEach(function (item) {
                            if (legendItemMatchesEdge(item, edge)) {
                                activeLegend[item.id] = true;
                            }
                        });
                    }
                });
            }
            Object.keys(legendButtons).forEach(function (id) {
                legendButtons[id].classList.toggle("active", Boolean(activeLegend[id]));
            });

            details.innerHTML = "";
            if (hover && hover.kind === "legend") {
                var legendEntry = graph.legend.filter(function (item) {
                    return item.id === hover.id;
                })[0];
                if (legendEntry) {
                    var count = graph.nodes.filter(function (node) {
                        return legendItemMatchesNode(legendEntry, node);
                    }).length;
                    var h = el("h2", null, details);
                    el("span", { text: "Legend" }, h);
                    el("span", { class: "gcg-pill sm active", text: legendEntry.label }, h);
                    el("p", { text: legendEntry.explain }, details);
                    el(
                        "p",
                        {
                            class: "muted",
                            text: count
                                ? count + " chips match. The graph lights those chips and their edges."
                                : "Hover a path on the graph to see this mark."
                        },
                        details
                    );
                }
            } else if (hover && hover.kind === "node") {
                var focus = byId[hover.id];
                var lanes = lanesThrough(focus.id);
                var mixed = mixedTerminus(focus.id);
                var showStart = startVisible(focus.id);
                var showStop = stopVisible(focus.id);
                var head = el("h2", null, details);
                el("span", { text: focus.label }, head);
                el("span", { class: "gcg-pill sm active", text: lanes.length + (lanes.length === 1 ? " lane" : " lanes") }, head);
                if (focus.sub) {
                    el("p", { class: "muted", text: focus.sub }, details);
                }
                if (showStart) {
                    el("p", { text: "Green triangle: every highlighted lane starts here." }, details);
                }
                if (showStop) {
                    el(
                        "p",
                        {
                            text: "Red octagon: every highlighted lane that touches this chip ends here."
                        },
                        details
                    );
                }
                if (focus.unify) {
                    el("p", { text: "Unification: " + focus.unify.action }, details);
                    el("p", { text: focus.unify.why }, details);
                    el("hr", { class: "gcg-hr" }, details);
                }
                var note = focus.note || (graph.notes && graph.notes[focus.stage]);
                if (graph.notes && graph.notes[focus.id]) {
                    note = graph.notes[focus.id];
                }
                if (note) {
                    el("p", { text: note }, details);
                }
                var ins = graph.edges.filter(function (edge) {
                    return edge.to === focus.id;
                });
                var outs = graph.edges.filter(function (edge) {
                    return edge.from === focus.id;
                });
                el("h3", { text: "In" }, details);
                var inRow = el("div", { class: "gcg-pills" }, details);
                if (!ins.length) {
                    el("span", { class: "muted", text: "No inbound edges" }, inRow);
                } else {
                    ins.forEach(function (edge) {
                        el("span", { class: "gcg-pill sm", text: labelOf(edge.from) }, inRow);
                    });
                }
                el("hr", { class: "gcg-hr" }, details);
                el("h3", { text: "Out" }, details);
                var outRow = el("div", { class: "gcg-pills" }, details);
                if (!outs.length) {
                    el("span", { class: "muted", text: "No outbound edges" }, outRow);
                } else {
                    outs.forEach(function (edge) {
                        el("span", { class: "gcg-pill sm", text: labelOf(edge.to) }, outRow);
                    });
                }
                el("hr", { class: "gcg-hr" }, details);
                el("h3", { text: "Full lanes through this chip" }, details);
                var laneRow = el("div", { class: "gcg-pills" }, details);
                lanes.forEach(function (lane) {
                    el("span", { class: "gcg-pill sm active", text: lane.label }, laneRow);
                });
                if (mixed && !showStop) {
                    el(
                        "p",
                        {
                            class: "muted",
                            text:
                                mixed.stops.length +
                                " lane" +
                                (mixed.stops.length === 1 ? "" : "s") +
                                " end here, " +
                                mixed.continues.length +
                                " continue. The stop stays hidden while those paths overlap."
                        },
                        details
                    );
                }
            } else {
                el("h2", { text: "Hover a chip or the legend" }, details);
                el(
                    "p",
                    {
                        class: "muted",
                        text: "A chip lights every lane through it. Start and stop marks appear only when that highlighted path uniquely begins or ends on the chip."
                    },
                    details
                );
            }
        }

        paint();
    }

    document.addEventListener("DOMContentLoaded", function () {
        var graph = window.GRAPHICAL_CODE_GRAPH;
        var mount = document.getElementById("graph");
        if (!graph || !mount) {
            return;
        }
        GraphicalCodeGraph(graph, mount);
    });
})();
