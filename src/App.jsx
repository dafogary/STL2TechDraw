import React, { useState, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { motion } from "framer-motion";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";
import jsPDF from "jspdf";

function getRotatedGeometry(geom, rot) {
  if (rot.x === 0 && rot.y === 0 && rot.z === 0) return geom;
  const cloned = geom.clone();
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rot.x),
    THREE.MathUtils.degToRad(rot.y),
    THREE.MathUtils.degToRad(rot.z)
  );
  cloned.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler));
  cloned.computeBoundingBox();
  return cloned;
}

// Returns geometry with user rotation + a fixed isometric tilt for the 3D preview.
// Uses only Three.js math — no WebGLRenderer to avoid clearMarks issues.
function getPreview3DGeometry(geom, rot) {
  const cloned = geom.clone();
  const userMatrix = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(rot.x),
      THREE.MathUtils.degToRad(rot.y),
      THREE.MathUtils.degToRad(rot.z)
    )
  );
  // Fixed viewing tilt so the preview shows real depth
  const tiltMatrix = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(-20), THREE.MathUtils.degToRad(35), 0)
  );
  // Apply user rotation first, then the view tilt
  cloned.applyMatrix4(tiltMatrix.multiply(userMatrix));
  cloned.computeBoundingBox();
  return cloned;
}

function createEmptyAutoCircles() {
  return { front: [], top: [], sideRight: [], sideLeft: [] };
}

function isFullAutoCircle(circle) {
  return circle.rSectors >= 14 && circle.rGap <= 1;
}

function getAutoCircleType(circle) {
  if (isFullAutoCircle(circle)) return 'fullCircles';
  // Adaptive sector requirement: larger radii need fewer sectors for same coverage
  // Very large arcs (R>15mm) only need 4+ sectors (25% coverage, catches quarter circles)
  // Large arcs (R>8mm) only need 5+ sectors (31% coverage)
  if (circle.radiusMM > 15 && circle.rSectors >= 4) return 'majorProfileArcs';
  if (circle.radiusMM > 8 && circle.rSectors >= 5) return 'majorProfileArcs';
  return 'profileRadii';
}

function summarizeAutoCircles(circleGroups) {
  const summary = { fullCircles: 0, profileRadii: 0, majorProfileArcs: 0, total: 0 };
  Object.values(circleGroups).flat().forEach((circle) => {
    summary[getAutoCircleType(circle)] += 1;
    summary.total += 1;
  });
  return summary;
}

function isSideView(viewType) {
  return viewType === 'sideRight' || viewType === 'sideLeft';
}

function getMajorProfileArcVisibilityScore(circle) {
  return ((circle.rSectors - circle.rGap) * 100) + (circle.rSectors * 10) + circle.radiusMM;
}

function isSameMajorProfileArcFeature(a, b) {
  const maxRadius = Math.max(a.radiusMM, b.radiusMM);
  const radiusTolerance = Math.max(0.75, maxRadius * 0.08);
  if (Math.abs(a.radiusMM - b.radiusMM) > radiusTolerance) return false;

  const centerTolerance = Math.max(1.5, maxRadius * 0.18);
  const dx = a.meanMX - b.meanMX;
  const dy = a.meanMY - b.meanMY;
  const dz = a.meanMZ - b.meanMZ;
  return (dx * dx) + (dy * dy) + (dz * dz) <= centerTolerance * centerTolerance;
}

function compareMajorProfileArcCandidates(a, b) {
  const scoreDiff = getMajorProfileArcVisibilityScore(b.circle) - getMajorProfileArcVisibilityScore(a.circle);
  if (scoreDiff !== 0) return scoreDiff;
  if (b.circle.radiusMM !== a.circle.radiusMM) return b.circle.radiusMM - a.circle.radiusMM;
  if (b.circle.rSectors !== a.circle.rSectors) return b.circle.rSectors - a.circle.rSectors;
  return a.viewType.localeCompare(b.viewType);
}

function buildPrimaryMajorArcViewMap(circleGroups, activeViews, showSideViewDetails) {
  const canShow = (viewType) => activeViews[viewType] && (!isSideView(viewType) || showSideViewDetails);
  const groups = [];

  Object.entries(circleGroups).forEach(([viewType, circles]) => {
    circles.forEach((circle) => {
      if (getAutoCircleType(circle) !== 'majorProfileArcs') return;

      const existingGroup = groups.find((group) => (
        group.members.some((member) => isSameMajorProfileArcFeature(member.circle, circle))
      ));

      if (existingGroup) {
        existingGroup.members.push({ viewType, circle });
        return;
      }

      groups.push({ members: [{ viewType, circle }] });
    });
  });

  const primaryViewByCircle = new Map();
  groups.forEach((group) => {
    const visibleMembers = group.members.filter(({ viewType }) => canShow(viewType));
    if (visibleMembers.length === 0) return;

    visibleMembers.sort(compareMajorProfileArcCandidates);
    const primaryMember = visibleMembers[0];
    primaryViewByCircle.set(primaryMember.circle, primaryMember.viewType);
  });

  return primaryViewByCircle;
}

function getAlternatingStackOffset(index, step) {
  if (index === 0) return 0;
  const magnitude = Math.ceil(index / 2) * step;
  return index % 2 === 1 ? -magnitude : magnitude;
}

function formatDrawingDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function pickFirstEnabledView(activeViews, preferredViewTypes) {
  return preferredViewTypes.find((viewType) => activeViews[viewType]) ?? null;
}

function getOverallDimensionHosts(activeViews) {
  return {
    width: pickFirstEnabledView(activeViews, ['front', 'top']),
    height: pickFirstEnabledView(activeViews, ['sideRight', 'sideLeft', 'front']),
    depth: pickFirstEnabledView(activeViews, ['top', 'sideRight', 'sideLeft']),
  };
}

function getLongestEmptySectorRun(sectors) {
  const sectorCount = sectors.length;
  const firstHit = sectors.findIndex(Boolean);
  if (firstHit === -1) {
    return { length: sectorCount, startIndex: 0, endIndex: sectorCount - 1 };
  }

  let bestStartIndex = -1;
  let bestLength = 0;
  let currentStartIndex = -1;
  let currentLength = 0;

  for (let step = 0; step < sectorCount; step++) {
    const sectorIndex = (firstHit + step) % sectorCount;
    if (!sectors[sectorIndex]) {
      if (currentLength === 0) currentStartIndex = sectorIndex;
      currentLength += 1;
      if (currentLength > bestLength) {
        bestLength = currentLength;
        bestStartIndex = currentStartIndex;
      }
      continue;
    }

    currentStartIndex = -1;
    currentLength = 0;
  }

  return {
    length: bestLength,
    startIndex: bestStartIndex,
    endIndex: bestStartIndex === -1 ? -1 : (bestStartIndex + bestLength - 1) % sectorCount,
  };
}

function getModelPointForViewPlane(viewType, planeX, planeY, orthogonalValue) {
  if (viewType === 'front') {
    return { mx: planeX, my: planeY, mz: orthogonalValue };
  }
  if (viewType === 'top') {
    return { mx: planeX, my: orthogonalValue, mz: planeY };
  }
  return { mx: orthogonalValue, my: planeY, mz: planeX };
}

function getClosestPointOnSegment(pointX, pointY, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-6) {
    const dist2 = (pointX - x1) * (pointX - x1) + (pointY - y1) * (pointY - y1);
    return { x: x1, y: y1, dist2, dirX: 0, dirY: 0, length: 0 };
  }

  const length = Math.sqrt(lenSq);
  const t = Math.max(0, Math.min(1, ((pointX - x1) * dx + (pointY - y1) * dy) / lenSq));
  const x = x1 + dx * t;
  const y = y1 + dy * t;
  return {
    x,
    y,
    dist2: (pointX - x) * (pointX - x) + (pointY - y) * (pointY - y),
    dirX: dx / length,
    dirY: dy / length,
    length,
  };
}

function snapPointToEdges(point, edges, options = {}) {
  const {
    threshold = 14,
    preferEndpoints = false,
    preferPerpendicularTo = null,
    excludeEdgeIndex = -1,
  } = options;

  if (!edges || edges.length === 0) {
    return { x: point.x, y: point.y, edgeIndex: -1, distance: Infinity };
  }

  let preferredDir = null;
  if (preferPerpendicularTo) {
    const prefLen = Math.hypot(preferPerpendicularTo.x, preferPerpendicularTo.y);
    if (prefLen > 1e-6) {
      preferredDir = {
        x: preferPerpendicularTo.x / prefLen,
        y: preferPerpendicularTo.y / prefLen,
      };
    }
  }

  // When endpoints are preferred (e.g. the dimension tool snapping corner-to-corner),
  // give true vertices priority: find the closest edge endpoint within the threshold and
  // snap straight to it. Only fall back to perpendicular edge projection if no vertex is
  // close enough. This makes corner snapping reliable instead of sliding onto the edge line.
  if (preferEndpoints) {
    let bestEndpoint = null;
    edges.forEach((edge, edgeIndex) => {
      if (edgeIndex === excludeEdgeIndex) return;
      const verts = [edge.p1, edge.p2];
      verts.forEach(([vx, vy]) => {
        const distance = Math.hypot(point.x - vx, point.y - vy);
        if (distance > threshold) return;
        if (!bestEndpoint || distance < bestEndpoint.distance) {
          bestEndpoint = { x: vx, y: vy, distance, edgeIndex };
        }
      });
    });
    if (bestEndpoint) {
      return { x: bestEndpoint.x, y: bestEndpoint.y, edgeIndex: bestEndpoint.edgeIndex, distance: bestEndpoint.distance };
    }
  }

  let bestCandidate = null;
  edges.forEach((edge, edgeIndex) => {
    if (edgeIndex === excludeEdgeIndex) return;

    const [x1, y1] = edge.p1;
    const [x2, y2] = edge.p2;
    const projected = getClosestPointOnSegment(point.x, point.y, x1, y1, x2, y2);
    if (projected.length < 1e-6) return;

    let candidate = {
      x: projected.x,
      y: projected.y,
      distance: Math.sqrt(projected.dist2),
    };

    if (candidate.distance > threshold) return;

    let score = candidate.distance;
    if (preferredDir) {
      const absDot = Math.abs(projected.dirX * preferredDir.x + projected.dirY * preferredDir.y);
      score += absDot * threshold * 0.75;
    }

    if (!bestCandidate || score < bestCandidate.score) {
      bestCandidate = {
        x: candidate.x,
        y: candidate.y,
        distance: candidate.distance,
        edgeIndex,
        score,
      };
    }
  });

  return bestCandidate ?? { x: point.x, y: point.y, edgeIndex: -1, distance: Infinity };
}

function resolveGapOpeningEndpoints(circle, edges, fallbackStart, fallbackEnd) {
  if (!edges || edges.length === 0) return null;

  const rawValues = [circle.gapStartX_, circle.gapStartY_, circle.gapEndX_, circle.gapEndY_];
  if (rawValues.some((value) => !Number.isFinite(value))) return null;

  const rawSpanX = circle.gapEndX_ - circle.gapStartX_;
  const rawSpanY = circle.gapEndY_ - circle.gapStartY_;
  const rawSpanLength = Math.hypot(rawSpanX, rawSpanY);
  if (rawSpanLength < 1e-6) return null;

  const gapAxisX = rawSpanX / rawSpanLength;
  const gapAxisY = rawSpanY / rawSpanLength;
  const rawMidX = (circle.gapStartX_ + circle.gapEndX_) / 2;
  const rawMidY = (circle.gapStartY_ + circle.gapEndY_) / 2;

  let gapNormalX = rawMidX - circle.cx_;
  let gapNormalY = rawMidY - circle.cy_;
  const gapNormalLength = Math.hypot(gapNormalX, gapNormalY);
  if (gapNormalLength > 1e-6) {
    gapNormalX /= gapNormalLength;
    gapNormalY /= gapNormalLength;
  } else {
    gapNormalX = gapAxisY;
    gapNormalY = -gapAxisX;
  }

  const silhouetteEdges = edges.filter((edge) => edge.type === 'silhouette');
  const sourceEdges = silhouetteEdges.length > 0 ? silhouetteEdges : edges;
  const pointKey = (x, y) => `${Math.round(x * 2)}_${Math.round(y * 2)}`;

  const walkTowardsInterior = (startPoint) => {
    let currentPoint = { x: startPoint.x, y: startPoint.y };
    let currentOutward = ((currentPoint.x - rawMidX) * gapNormalX) + ((currentPoint.y - rawMidY) * gapNormalY);
    const visited = new Set([pointKey(currentPoint.x, currentPoint.y)]);

    for (let step = 0; step < 24; step++) {
      let bestCandidate = null;

      sourceEdges.forEach((edge) => {
        [
          { shared: edge.p1, other: edge.p2 },
          { shared: edge.p2, other: edge.p1 },
        ].forEach(({ shared, other }) => {
          if (Math.hypot(shared[0] - currentPoint.x, shared[1] - currentPoint.y) > 2) return;

          const dx = other[0] - shared[0];
          const dy = other[1] - shared[1];
          const length = Math.hypot(dx, dy);
          if (length < 1.5) return;

          const dirX = dx / length;
          const dirY = dy / length;
          const inwardness = -(dirX * gapNormalX + dirY * gapNormalY);
          const axisAlignment = Math.abs(dirX * gapAxisX + dirY * gapAxisY);
          const nextOutward = ((other[0] - rawMidX) * gapNormalX) + ((other[1] - rawMidY) * gapNormalY);
          const inwardGain = currentOutward - nextOutward;
          const nextKey = pointKey(other[0], other[1]);

          if (visited.has(nextKey)) return;
          if (inwardness < 0.45) return;
          if (axisAlignment > 0.8) return;
          if (inwardGain < 0.75) return;

          const score = (inwardness * 100) + inwardGain + length;
          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = {
              point: { x: other[0], y: other[1] },
              outward: nextOutward,
              score,
              key: nextKey,
            };
          }
        });
      });

      if (!bestCandidate) break;
      currentPoint = bestCandidate.point;
      currentOutward = bestCandidate.outward;
      visited.add(bestCandidate.key);
    }

    return currentPoint;
  };

  const collectNearbyVertices = (target) => {
    const searchRadius = Math.max(20, Math.min(rawSpanLength * 0.4, 60));
    const candidates = new Map();
    const addPoint = (x, y) => {
      const distance = Math.hypot(x - target.x, y - target.y);
      if (distance > searchRadius) return;
      const key = pointKey(x, y);
      const existing = candidates.get(key);
      if (!existing || distance < existing.distance) {
        candidates.set(key, { x, y, distance });
      }
    };

    sourceEdges.forEach((edge) => {
      addPoint(edge.p1[0], edge.p1[1]);
      addPoint(edge.p2[0], edge.p2[1]);
    });
    addPoint(target.x, target.y);

    return [...candidates.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8)
      .map(({ x, y }) => ({ x, y }));
  };

  const fallbackSpanLength = Math.hypot(fallbackEnd.x - fallbackStart.x, fallbackEnd.y - fallbackStart.y);
  const startCandidates = collectNearbyVertices(fallbackStart);
  const endCandidates = collectNearbyVertices(fallbackEnd);
  let bestResolvedGap = null;

  startCandidates.forEach((startCandidate) => {
    const refinedStart = walkTowardsInterior(startCandidate);
    endCandidates.forEach((endCandidate) => {
      const refinedEnd = walkTowardsInterior(endCandidate);
      const spanX = refinedEnd.x - refinedStart.x;
      const spanY = refinedEnd.y - refinedStart.y;
      const spanLength = Math.hypot(spanX, spanY);
      if (spanLength < 6) return;

      const dirX = spanX / spanLength;
      const dirY = spanY / spanLength;
      const alignment = Math.abs(dirX * gapAxisX + dirY * gapAxisY);
      if (alignment < 0.75) return;

      const normalDelta = Math.abs(spanX * gapNormalX + spanY * gapNormalY);
      if (normalDelta > Math.max(12, spanLength * 0.3)) return;

      const narrowingGain = fallbackSpanLength - spanLength;
      if (narrowingGain < 2) return;

      // Prefer solutions that found a narrower opening (moved inward)
      const score = (narrowingGain * 15) + (alignment * 25) - normalDelta * 0.5;

      if (!bestResolvedGap || score > bestResolvedGap.score) {
        bestResolvedGap = {
          start: refinedStart,
          end: refinedEnd,
          length: spanLength,
          score,
        };
      }
    });
  });

  if (bestResolvedGap) {
    return {
      start: bestResolvedGap.start,
      end: bestResolvedGap.end,
      length: bestResolvedGap.length,
    };
  }

  return null;
}

function getProfileRadiiHostViews(sourceView, enabledViews, activeViews, showSideViewDetails) {
  const hostViews = new Set();
  const addView = (viewType) => {
    if (!activeViews[viewType]) return;
    if (isSideView(viewType) && !showSideViewDetails) return;
    hostViews.add(viewType);
  };

  if (enabledViews.detected) addView(sourceView);
  if (enabledViews.front) addView('front');
  if (enabledViews.top) addView('top');
  if (enabledViews.sideRight) addView('sideRight');
  if (enabledViews.sideLeft) addView('sideLeft');

  return [...hostViews];
}

export default function STLToDrawingApp() {
  const [fileName, setFileName] = useState("");
  const [author, setAuthor] = useState("");
  const [company, setCompany] = useState("");
  const [drawingName, setDrawingName] = useState("");
  const [dimensions, setDimensions] = useState({ width: true, height: true, depth: true });
  const [views, setViews] = useState({ front: true, top: false, sideRight: false, sideLeft: false });
  const [projectionType, setProjectionType] = useState("first"); // "first" (ISO) or "third" (ASME)
  const [stlDimensions, setStlDimensions] = useState(null);
  const [drawingDate] = useState(formatDrawingDate());
  const [geometry, setGeometry] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [currentTool, setCurrentTool] = useState('none'); // 'none', 'radius', 'angle', 'dimension', 'text'
  const [tempPoints, setTempPoints] = useState([]);
  const [mouseCanvasPos, setMouseCanvasPos] = useState(null);
  const [hoverSnapPreview, setHoverSnapPreview] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPosition, setLastPanPosition] = useState({ x: 0, y: 0 });
  const [drawingScale, setDrawingScale] = useState(1);
  const [useManualScale, setUseManualScale] = useState(false);
  const [manualScale, setManualScale] = useState("1");
  const [rotation, setRotation] = useState({ x: 0, y: 0, z: 0 });
  const [drawingOffset, setDrawingOffset] = useState({ x: 0, y: 0 });
  const [isDraggingView, setIsDraggingView] = useState(false);
  const canvasRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  // Refs keep 3D drag stateless (no re-renders during move)
  const liveRotationRef = useRef({ x: 0, y: 0, z: 0 });
  const isDragging3DRef = useRef(false);
  const lastDragPos3DRef = useRef({ x: 0, y: 0 });
  // Per-view drag state (refs to avoid re-renders during drag)
  const viewBBoxesRef = useRef({});
  const draggingViewRef = useRef(null); // { name, startX, startY, startOffsetX, startOffsetY }
  const donateRenderedRef = useRef(false);
  // Model-space circle cache keyed by viewType — populated by detection useEffect, read by draw2D
  const autoCirclesRef = useRef(createEmptyAutoCircles());
  const projectedEdgesRef = useRef(createEmptyAutoCircles());
  // Circles actually drawn per view, in CANVAS coordinates (cx_, cy_, r). Used by
  // the manual Radius tool to snap to the same arcs the user sees on the sheet.
  const drawnCirclesRef = useRef(createEmptyAutoCircles());
  const currentScaleRef = useRef(1);
  const annotationRegionsRef = useRef([]); // Stores clickable regions for all annotations
  const [detectedCircleCount, setDetectedCircleCount] = useState(0);
  const [detectedCircleBreakdown, setDetectedCircleBreakdown] = useState({ fullCircles: 0, profileRadii: 0, majorProfileArcs: 0, total: 0 });
  const [autoDetectionFilters, setAutoDetectionFilters] = useState({ fullCircles: true, profileRadii: true, majorProfileArcs: true });
  const [showAutoGaps, setShowAutoGaps] = useState(false);
  const [profileRadiiViews, setProfileRadiiViews] = useState({ detected: false, front: false, top: true, sideRight: false, sideLeft: false });
  const [showSideViewDetails, setShowSideViewDetails] = useState(false);
  const [minRadiusFilter, setMinRadiusFilter] = useState(0);
  const [maxRadiusFilter, setMaxRadiusFilter] = useState(20);
  const [hiddenAutoAnnotations, setHiddenAutoAnnotations] = useState(new Set());
  const DEBUG_AUTO_CIRCLES = false;
  const circleDebugLog = (...args) => {
    if (DEBUG_AUTO_CIRCLES) console.log(...args);
  };
  const applyDetectedCircles = (circlesByView) => {
    autoCirclesRef.current = circlesByView;
    const summary = summarizeAutoCircles(circlesByView);
    setDetectedCircleBreakdown(summary);
    setDetectedCircleCount(summary.total);
  };

  // A3 size in pixels at ~140 DPI for good quality (420mm × 297mm)
  const CANVAS_WIDTH = 1754;
  const CANVAS_HEIGHT = 1240;

  // Redraw when annotations, zoom, pan, views or dimensions change
  useEffect(() => {
    if (geometry && stlDimensions) {
      draw2D(geometry, stlDimensions.width, stlDimensions.height, stlDimensions.depth);
    }
  }, [annotations, tempPoints, hoverSnapPreview, mouseCanvasPos, zoom, panOffset, showAnnotations, useManualScale, manualScale, views.front, views.top, views.sideRight, views.sideLeft, dimensions.width, dimensions.height, dimensions.depth, rotation, projectionType, drawingOffset, detectedCircleCount, autoDetectionFilters.fullCircles, autoDetectionFilters.profileRadii, autoDetectionFilters.majorProfileArcs, profileRadiiViews, showSideViewDetails]);

  // Initialise PayPal donate button once on mount
  useEffect(() => {
    const init = () => {
      const container = document.getElementById('donate-button');
      if (donateRenderedRef.current) return;
      if (window.PayPal?.Donation?.Button && container) {
        donateRenderedRef.current = true;
        window.PayPal.Donation.Button({
          env: 'production',
          hosted_button_id: '6SM9F5FPT7K4S',
          image: {
            src: 'https://www.paypalobjects.com/en_US/GB/i/btn/btn_donateCC_LG.gif',
            alt: 'Donate with PayPal button',
            title: 'PayPal - The safer, easier way to pay online!',
          },
        }).render('#donate-button');
      }
    };
    // SDK may load after component mounts
    if (window.PayPal) { init(); } else {
      const interval = setInterval(() => { if (window.PayPal) { clearInterval(interval); init(); } }, 200);
      return () => clearInterval(interval);
    }
  }, []);
  useEffect(() => {
    if (!geometry) {
      applyDetectedCircles(createEmptyAutoCircles());
      projectedEdgesRef.current = createEmptyAutoCircles();
      return;
    }
    const rotGeom = getRotatedGeometry(geometry, rotation);
    rotGeom.computeBoundingBox();
    const bbox = rotGeom.boundingBox;
    const positions = rotGeom.attributes.position.array;
    const cx = (bbox.max.x + bbox.min.x) / 2;
    const cy = (bbox.max.y + bbox.min.y) / 2;
    const cz = (bbox.max.z + bbox.min.z) / 2;
    const rotWidth  = bbox.max.x - bbox.min.x;
    const rotHeight = bbox.max.y - bbox.min.y;
    const rotDepth  = bbox.max.z - bbox.min.z;

    // Always detect circles in all views — the part may be rectangular overall
    // but still contain circular features (holes, bosses, cylinders).
    const front     = detectCircles(positions, 'front',     cx, cy, cz);
    const top       = detectCircles(positions, 'top',       cx, cy, cz);
    const sideRight = detectCircles(positions, 'sideRight', cx, cy, cz);
    const sideLeft  = detectCircles(positions, 'sideLeft',  cx, cy, cz);
    applyDetectedCircles({ front, top, sideRight, sideLeft });

    // Update Overall Size text annotation
    setAnnotations([{
      type: 'text',
      text: `Overall Size: ${rotWidth.toFixed(1)} × ${rotHeight.toFixed(1)} × ${rotDepth.toFixed(1)} mm`,
      x: 90, y: 45
    }]);
  }, [geometry, rotation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync liveRotationRef and redraw 3D preview whenever geometry or committed rotation changes
  useEffect(() => {
    liveRotationRef.current = rotation;
    if (geometry) {
      // rAF ensures the canvas is in the DOM before we try to draw
      requestAnimationFrame(() => draw3DPreview());
    }
  }, [geometry, rotation]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = function (e) {
      const loader = new STLLoader();
      const loadedGeometry = loader.parse(e.target.result);
      loadedGeometry.computeBoundingBox();
      const bbox = loadedGeometry.boundingBox;

      const width = bbox.max.x - bbox.min.x;
      const height = bbox.max.y - bbox.min.y;
      const depth = bbox.max.z - bbox.min.z;

      setGeometry(loadedGeometry);
      setStlDimensions({ width, height, depth });
      setAnnotations([]); // Clear annotations when new file is loaded
      autoCirclesRef.current = { front: [], top: [], sideRight: [], sideLeft: [] };
      projectedEdgesRef.current = createEmptyAutoCircles();
      setDetectedCircleCount(0);
      setZoom(1);
      setPanOffset({ x: 0, y: 0 });
      setDrawingOffset({ x: 0, y: 0 });
      viewBBoxesRef.current = {};
      
      // Auto-detect features for annotations
      const autoAnnotations = detectFeatures(loadedGeometry, bbox, width, height, depth);
      setAnnotations(autoAnnotations);
      
      draw2D(loadedGeometry, width, height, depth);
    };
    reader.readAsArrayBuffer(file);
  };

  const detectFeatures = (geom, bbox, width, height, depth) => {
    // Circle detection is now handled by autoCirclesRef (model-space, in useEffect).
    // This only returns the Overall Size text annotation.
    return [{
      type: 'text',
      text: `Overall Size: ${width.toFixed(1)} × ${height.toFixed(1)} × ${depth.toFixed(1)} mm`,
      x: 90, y: 45
    }];
  };

  const detectCircles = (positions, viewType, centerModelX, centerModelY, centerModelZ) => {
    const circles = [];

    // === Step 1: Parse wall faces ===
    // Keep faces whose normal is nearly perpendicular to the view axis (cylindrical wall faces).
    // Project each face's centroid and normal onto the 2-D view plane and normalise.
    const wallFaces = []; // { px, py, nx, ny (unit in-plane), mx, my, mz (3-D centroid) }
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const x0 = positions[i],   y0 = positions[i+1], z0 = positions[i+2];
      const x1 = positions[i+3], y1 = positions[i+4], z1 = positions[i+5];
      const x2 = positions[i+6], y2 = positions[i+7], z2 = positions[i+8];

      const e1x = x1-x0, e1y = y1-y0, e1z = z1-z0;
      const e2x = x2-x0, e2y = y2-y0, e2z = z2-z0;
      const fnx = e1y*e2z - e1z*e2y;
      const fny = e1z*e2x - e1x*e2z;
      const fnz = e1x*e2y - e1y*e2x;
      const fnLen = Math.sqrt(fnx*fnx + fny*fny + fnz*fnz);
      if (fnLen < 1e-10) continue;

      // Fraction of normal pointing along the view axis
      let viewComp;
      if      (viewType === 'front') viewComp = Math.abs(fnz / fnLen);
      else if (viewType === 'top')   viewComp = Math.abs(fny / fnLen);
      else                           viewComp = Math.abs(fnx / fnLen);
      if (viewComp > 0.35) continue; // skip flat cap / near-flat faces

      const mx = (x0+x1+x2)/3, my = (y0+y1+y2)/3, mz = (z0+z1+z2)/3;

      // Project centroid and normal into the view plane
      let px, py, pnx, pny;
      if      (viewType === 'front') { px = mx; py = my; pnx = fnx; pny = fny; }
      else if (viewType === 'top')   { px = mx; py = mz; pnx = fnx; pny = fnz; }
      else                           { px = mz; py = my; pnx = fnz; pny = fny; }

      const pnLen = Math.sqrt(pnx*pnx + pny*pny);
      if (pnLen < 0.1) continue; // degenerate in-plane projection
      wallFaces.push({ px, py, nx: pnx/pnLen, ny: pny/pnLen, mx, my, mz });
    }
    if (wallFaces.length < 15) return circles;

    // === Step 1b: Curved-face filter ===
    // Flat walls have identical normals across all their faces — their normal lines never
    // converge at a finite centre, yet they pollute the Hough accumulator.
    // Keep only faces that have at least one nearby neighbour with a clearly different
    // normal (≥ MIN_CURVE_DEG°).  Cylinder faces always pass; flat-wall faces do not.
    // Corner fillets (≈90° arc) also pass but their Hough peaks fail the sector check later.
    //
    // Neighbourhood radius: adaptive — use 2.5× the estimated average triangle edge length,
    // clamped to [2, 20] mm so it works for both fine and coarse meshes.
    let edgeSumLen = 0, edgeSamples = 0;
    for (let i = 0; i < Math.min(positions.length, 9000); i += 9) {
      edgeSumLen += Math.hypot(
        positions[i+3]-positions[i], positions[i+4]-positions[i+1], positions[i+5]-positions[i+2]);
      edgeSamples++;
    }
    const avgEdge    = edgeSamples > 0 ? edgeSumLen / edgeSamples : 1;
    const NBHD_R     = Math.max(2, Math.min(avgEdge * 2.5, 20)); // mm
    const NBHD_R2    = NBHD_R * NBHD_R;
    const MIN_CURVE  = Math.cos(12 * Math.PI / 180); // dot < this ↔ angle > 12°
    const GRID_SZ    = NBHD_R * 1.1;

    const spatialGrid = new Map();
    wallFaces.forEach((f, i) => {
      const k = `${Math.floor(f.px/GRID_SZ)}_${Math.floor(f.py/GRID_SZ)}`;
      if (!spatialGrid.has(k)) spatialGrid.set(k, []);
      spatialGrid.get(k).push(i);
    });

    const curvedFaces = wallFaces.filter((f, i) => {
      const gx = Math.floor(f.px/GRID_SZ), gy = Math.floor(f.py/GRID_SZ);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nbrs = spatialGrid.get(`${gx+dx}_${gy+dy}`);
          if (!nbrs) continue;
          for (const j of nbrs) {
            if (j === i) continue;
            const ex = wallFaces[j].px - f.px, ey = wallFaces[j].py - f.py;
            if (ex*ex + ey*ey > NBHD_R2) continue;
            // dot < MIN_CURVE means angle > 8° — face is on a curved surface
            if (f.nx*wallFaces[j].nx + f.ny*wallFaces[j].ny < MIN_CURVE) return true;
          }
        }
      }
      return false;
    });

    circleDebugLog(`[detectCircles ${viewType}] wallFaces=${wallFaces.length} curvedFaces=${curvedFaces.length} avgEdge=${avgEdge.toFixed(2)}mm NBHD_R=${NBHD_R.toFixed(2)}mm`);
    if (curvedFaces.length < 15) return circles;

    // === Step 2: Cluster curvedFaces into spatially connected components ===
    // Each component represents one curved feature (pin, boss, fillet, large arc, etc.).
    // Features that are physically separated become separate components, so we never mix
    // votes from unrelated parts of the geometry — the root cause of Hough false peaks.
    //
    // LINK_R must still connect adjacent faces on the same cylinder, but if it is
    // too large it merges a hole wall with a nearby outer round end and the whole
    // feature gets discarded as one oversized component.
    const LINK_R  = 1.8; // mm — small enough to keep neighbouring hole/arc features separate
    const LINK_R2 = LINK_R * LINK_R;
    const LGRID   = LINK_R;
    const linkGrid = new Map();
    curvedFaces.forEach((f, i) => {
      const k = `${Math.floor(f.px / LGRID)}_${Math.floor(f.py / LGRID)}`;
      if (!linkGrid.has(k)) linkGrid.set(k, []);
      linkGrid.get(k).push(i);
    });

    // Union-Find with path compression
    const uf = curvedFaces.map((_, i) => i);
    const ufFind = i => {
      while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; }
      return i;
    };

    curvedFaces.forEach((f, i) => {
      const gx = Math.floor(f.px / LGRID), gy = Math.floor(f.py / LGRID);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nbrs = linkGrid.get(`${gx+dx}_${gy+dy}`);
          if (!nbrs) continue;
          for (const j of nbrs) {
            if (j <= i) continue;
            const ex = curvedFaces[j].px - f.px, ey = curvedFaces[j].py - f.py;
            if (ex*ex + ey*ey <= LINK_R2) {
              const ri = ufFind(i), rj = ufFind(j);
              if (ri !== rj) uf[ri] = rj;
            }
          }
        }
      }
    });

    const components = new Map();
    curvedFaces.forEach((f, i) => {
      const root = ufFind(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(f);
    });
    {
      const sizes = [...components.values()].map(c => c.length).sort((a,b)=>b-a);
      circleDebugLog(`[detectCircles ${viewType}] LINK_R=${LINK_R.toFixed(2)}mm → ${components.size} components, sizes: [${sizes.slice(0,10).join(',')}]`);
    }

    // === Step 3: Validate each component and fit circles ===
    // A real cylinder (viewed end-on) has face centroids that form a CLOSED RING around
    // the axis — they span all 360° when measured from the cylinder axis.
    // Any arc (large fillet, J-bend, rounded end) only spans its own angular extent.
    // Key discriminator: max gap in the sector ring.
    // A full cylinder has faces all the way around → max gap ≤ 2 sectors even for sparse meshes.
    // Any open arc (90°, 180°, 270°) leaves a large gap: 4, 8, 4+ sectors.
    // With fragmented meshes, a cylinder may split into 2-3 pieces → allow gap up to 7 (157.5°).
    // Arcs ≥180° will have gap ≥8 and be rejected.
    const SECTORS          = 16;
    const MIN_SECTORS_PRE  = 4;   // quick pre-filter from cluster mean (lowered to catch quarter circles)
    const MIN_SECTORS_FINAL= 3;   // min sectors from fitted centre (18.75% coverage, allows quarter circles + sparse meshes)
    const MAX_GAP_SECTORS  = 13;  // max consecutive empty sectors allowed (292.5°, allows quarter circles with margin)
    const MIN_COMP_FACES   = 5;   // minimum faces per component (lowered for large sparse quarter-circle features)

    // Helper: check that a boolean sector array has ≥ minHit sectors AND no gap > maxGap
    const sectorsFull = (arr, minHit, maxGap) => {
      const numHit = arr.filter(Boolean).length;
      if (numHit < minHit) return false;
      const start = arr.findIndex(Boolean);
      if (start === -1) return false;
      let gap = 0;
      for (let s = 0; s < SECTORS; s++) {
        if (!arr[(start + s) % SECTORS]) { if (++gap > maxGap) return false; }
        else gap = 0;
      }
      return true;
    };
    const seen             = new Set();

    for (const comp of components.values()) {
      if (comp.length < MIN_COMP_FACES) { continue; }

      // --- Component diameter check ---
      const xs = comp.map(f => f.px), ys = comp.map(f => f.py);
      const diameter = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      circleDebugLog(`[detectCircles ${viewType}] comp size=${comp.length} diameter=${diameter.toFixed(1)}mm`);

      // --- Pre-filter: centroid spread from cluster mean ---
      const meanPX = comp.reduce((s, f) => s + f.px, 0) / comp.length;
      const meanPY = comp.reduce((s, f) => s + f.py, 0) / comp.length;
      const preSectors = new Array(SECTORS).fill(false);
      for (const f of comp) {
        const s = Math.floor(((Math.atan2(f.py - meanPY, f.px - meanPX) + Math.PI) / (2*Math.PI)) * SECTORS) % SECTORS;
        preSectors[s] = true;
      }
      const preHit = preSectors.filter(Boolean).length;
      circleDebugLog(`[detectCircles ${viewType}] comp size=${comp.length} mean=(${meanPX.toFixed(1)},${meanPY.toFixed(1)}) preSectors=${preHit}`);
      if (preHit < MIN_SECTORS_PRE) { circleDebugLog(`  → SKIP preSectors`); continue; }

      // --- Normal-line intersection: least-squares centre from face normals ---
      // Each face normal points radially toward/away from the cylinder axis.
      // Minimising sum of squared perpendicular distances from (cx,cy) to all
      // normal lines gives a clean 2×2 linear system solved in closed form.
      // Unlike Kasa (position-only), this works equally well for any mix of
      // coaxial cylinders because all their normals converge on the same axis.
      //
      // d_i = (cx - px_i)*ny_i - (cy - py_i)*nx_i = cx*ny_i - cy*nx_i - e_i
      // where e_i = px_i*ny_i - py_i*nx_i
      //
      // Normal equations:   [ sNY2   -sNXNY ] [cx]   [sENY]
      //                     [ sNXNY  -sNX2  ] [cy] = [sENX]
      let sNY2=0, sNXNY=0, sNX2=0, sENY=0, sENX=0;
      for (const f of comp) {
        const e = f.px*f.ny - f.py*f.nx;
        sNY2  += f.ny*f.ny;
        sNXNY += f.nx*f.ny;
        sNX2  += f.nx*f.nx;
        sENY  += e*f.ny;
        sENX  += e*f.nx;
      }
      const det = -(sNY2*sNX2 - sNXNY*sNXNY);
      if (Math.abs(det) < 1e-10) continue;
      const cx = (-sENY*sNX2 + sENX*sNXNY) / det;
      const cy = ( sNY2*sENX - sENY*sNXNY) / det;

      // --- Final ring check from FITTED centre ---
      // A true cylinder has centroids all the way round the axis (max gap ≤ 2–3 sectors).
      // Any open arc leaves a large angular gap that is caught by MAX_GAP_SECTORS = 3.
      const finalSectors = new Array(SECTORS).fill(false);
      for (const f of comp) {
        const s = Math.floor(((Math.atan2(f.py - cy, f.px - cx) + Math.PI) / (2*Math.PI)) * SECTORS) % SECTORS;
        finalSectors[s] = true;
      }
      const finalHit = finalSectors.filter(Boolean).length;
      const finalGapInfo = getLongestEmptySectorRun(finalSectors);
      const fGap = finalGapInfo.length;
      circleDebugLog(`  cx=${cx.toFixed(1)} cy=${cy.toFixed(1)} finalSectors=${finalHit}/16 maxGap=${fGap}`);
      if (!sectorsFull(finalSectors, MIN_SECTORS_FINAL, MAX_GAP_SECTORS)) { circleDebugLog(`  → SKIP finalSectors`); continue; }

      // --- Radius histogram: handles concentric cylinders (pin shaft + collar) ---
      const radii   = comp.map(f => Math.hypot(f.px - cx, f.py - cy));
      const maxR    = Math.max(...radii);
      if (maxR <= 0.5) { circleDebugLog(`  → SKIP maxR=${maxR.toFixed(2)}`); continue; }

      const BINS    = 60;
      const binSize = maxR / BINS;
      const bins    = new Array(BINS).fill(0);
      for (const r of radii) bins[Math.min(Math.floor(r / binSize), BINS-1)]++;
      const avgBin  = radii.length / BINS;

      let peakCount = 0;
      for (let b = 0; b < BINS; b++) {
        const left  = b === 0 ? -Infinity : bins[b - 1];
        const right = b === BINS - 1 ? -Infinity : bins[b + 1];
        if (bins[b] < Math.max(avgBin * 2.5, 3) || bins[b] <= left || bins[b] <= right) continue;
        peakCount++;
        const radiusMM = (b + 0.5) * binSize;
        circleDebugLog(`  histogram peak: R=${radiusMM.toFixed(2)}mm bin[${b}]=${bins[b]} (avg=${avgBin.toFixed(1)})`);

        // Faces at this specific radius — must ALSO span ≥ MIN_SECTORS_FINAL sectors
        const faceAtR = comp.filter(f =>
          Math.abs(Math.hypot(f.px - cx, f.py - cy) - radiusMM) < radiusMM * 0.25
        );
        if (faceAtR.length < 8) { circleDebugLog(`    → SKIP faceAtR.length=${faceAtR.length}`); continue; }

        const faceXs = faceAtR.map(f => f.px);
        const faceYs = faceAtR.map(f => f.py);
        const faceSpan = Math.hypot(Math.max(...faceXs) - Math.min(...faceXs), Math.max(...faceYs) - Math.min(...faceYs));
        const maxFaceSpan = radiusMM * 2 + avgEdge * 2;
        if (faceSpan > maxFaceSpan) {
          circleDebugLog(`    → SKIP faceSpan=${faceSpan.toFixed(2)}mm maxFaceSpan=${maxFaceSpan.toFixed(2)}mm`);
          continue;
        }

        const rSectors = new Array(SECTORS).fill(false);
        for (const f of faceAtR) {
          const s = Math.floor(((Math.atan2(f.py - cy, f.px - cx) + Math.PI) / (2*Math.PI)) * SECTORS) % SECTORS;
          rSectors[s] = true;
        }
        const rHit = rSectors.filter(Boolean).length;
        const radiusGapInfo = getLongestEmptySectorRun(rSectors);
        const rGap = radiusGapInfo.length;
        circleDebugLog(`    faceAtR=${faceAtR.length} rSectors=${rHit}/16 rGap=${rGap}`);
        if (!sectorsFull(rSectors, MIN_SECTORS_FINAL, MAX_GAP_SECTORS)) { circleDebugLog(`    → SKIP rSectors`); continue; }

        // Use 0.2mm radius precision (×5) so close-but-distinct radii (e.g. 1.97 vs 2.25mm) are not deduped
        const key = `${Math.round(cx*2)}_${Math.round(cy*2)}_${Math.round(radiusMM*5)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Back-project fitted centre to 3-D model space and keep one actual
        // supporting face centroid so leaders can land on a visible surface.
        const nI = faceAtR.length;
        const sMX = faceAtR.reduce((s,f) => s+f.mx, 0);
        const sMY = faceAtR.reduce((s,f) => s+f.my, 0);
        const sMZ = faceAtR.reduce((s,f) => s+f.mz, 0);
        const supportMX = sMX / nI;
        const supportMY = sMY / nI;
        const supportMZ = sMZ / nI;
        let supportFace = faceAtR[0];
        let supportFaceDist2 = Infinity;
        faceAtR.forEach((f) => {
          const dist2 =
            (f.mx - supportMX) * (f.mx - supportMX) +
            (f.my - supportMY) * (f.my - supportMY) +
            (f.mz - supportMZ) * (f.mz - supportMZ);
          if (dist2 < supportFaceDist2) {
            supportFace = f;
            supportFaceDist2 = dist2;
          }
        });
        let meanMX, meanMY, meanMZ;
        const orthogonalMean = viewType === 'front' ? sMZ / nI : viewType === 'top' ? sMY / nI : sMX / nI;
        if      (viewType === 'front') { meanMX = cx;     meanMY = cy;     meanMZ = orthogonalMean; }
        else if (viewType === 'top')   { meanMX = cx;     meanMY = orthogonalMean; meanMZ = cy;     }
        else                           { meanMX = orthogonalMean; meanMY = cy;     meanMZ = cx;     }

        let gapWidthMM = null;
        let gapStartMX = null;
        let gapStartMY = null;
        let gapStartMZ = null;
        let gapEndMX = null;
        let gapEndMY = null;
        let gapEndMZ = null;
        if (radiusGapInfo.length >= 2 && radiusGapInfo.startIndex !== -1) {
          const sectorAngle = (Math.PI * 2) / SECTORS;
          const gapStartAngle = -Math.PI + radiusGapInfo.startIndex * sectorAngle;
          const gapEndAngle = gapStartAngle + radiusGapInfo.length * sectorAngle;
          const gapStartPlaneX = cx + radiusMM * Math.cos(gapStartAngle);
          const gapStartPlaneY = cy + radiusMM * Math.sin(gapStartAngle);
          const gapEndPlaneX = cx + radiusMM * Math.cos(gapEndAngle);
          const gapEndPlaneY = cy + radiusMM * Math.sin(gapEndAngle);
          gapWidthMM = Math.hypot(gapEndPlaneX - gapStartPlaneX, gapEndPlaneY - gapStartPlaneY);

          const gapStartModelPoint = getModelPointForViewPlane(viewType, gapStartPlaneX, gapStartPlaneY, orthogonalMean);
          gapStartMX = gapStartModelPoint.mx;
          gapStartMY = gapStartModelPoint.my;
          gapStartMZ = gapStartModelPoint.mz;

          const gapEndModelPoint = getModelPointForViewPlane(viewType, gapEndPlaneX, gapEndPlaneY, orthogonalMean);
          gapEndMX = gapEndModelPoint.mx;
          gapEndMY = gapEndModelPoint.my;
          gapEndMZ = gapEndModelPoint.mz;
        }

        circles.push({
          radiusMM,
          meanMX,
          meanMY,
          meanMZ,
          surfaceMX: supportFace.mx,
          surfaceMY: supportFace.my,
          surfaceMZ: supportFace.mz,
          gapWidthMM,
          gapStartMX,
          gapStartMY,
          gapStartMZ,
          gapEndMX,
          gapEndMY,
          gapEndMZ,
          rSectors: rHit,
          rGap,
        });
        circleDebugLog(`    ✓ ACCEPTED R=${radiusMM.toFixed(2)}mm`);
      }
      if (peakCount === 0) circleDebugLog(`  → NO histogram peaks found (avgBin=${avgBin.toFixed(1)} threshold=${(Math.max(avgBin*2.5,3)).toFixed(1)})`);
    }

    // Keep circular features based on user-defined radius range and type
    const filtered = circles.filter((circle) => {
      const circleType = getAutoCircleType(circle);
      // Always include major profile arcs (they're important structural features)
      if (circleType === 'majorProfileArcs') return true;
      // For other circles, check if they're within the user's radius range
      return circle.radiusMM >= 0.1; // Just need to be valid (filtering happens at render time)
    });
    filtered.sort((a, b) => {
      const qa = a.rSectors - a.rGap;
      const qb = b.rSectors - b.rGap;
      if (qb !== qa) return qb - qa;       // better quality first
      return a.radiusMM - b.radiusMM;      // smaller radius first among equals
    });
    return filtered;
  };

  // Smart circle center detection for manual radius tool
  // Given a canvas point, finds nearby auto-detected circles or calculates center from curved faces
  const findCircleCenterNearPoint = (canvasX, canvasY, viewType) => {
    if (!geometry) return null;

    const fitCircleFromPoints = (points) => {
      if (!points || points.length < 6) return null;

      let sumX = 0;
      let sumY = 0;
      let sumX2 = 0;
      let sumY2 = 0;
      let sumXY = 0;
      let sumXZ = 0;
      let sumYZ = 0;
      let sumZ = 0;

      points.forEach((p) => {
        const x = p.x;
        const y = p.y;
        const z = x * x + y * y;
        sumX += x;
        sumY += y;
        sumX2 += x * x;
        sumY2 += y * y;
        sumXY += x * y;
        sumXZ += x * z;
        sumYZ += y * z;
        sumZ += z;
      });

      const n = points.length;
      const a11 = sumX2;
      const a12 = sumXY;
      const a13 = sumX;
      const a21 = sumXY;
      const a22 = sumY2;
      const a23 = sumY;
      const a31 = sumX;
      const a32 = sumY;
      const a33 = n;

      const b1 = -sumXZ;
      const b2 = -sumYZ;
      const b3 = -sumZ;

      const det =
        a11 * (a22 * a33 - a23 * a32) -
        a12 * (a21 * a33 - a23 * a31) +
        a13 * (a21 * a32 - a22 * a31);

      if (Math.abs(det) < 1e-9) return null;

      const detA =
        b1 * (a22 * a33 - a23 * a32) -
        a12 * (b2 * a33 - a23 * b3) +
        a13 * (b2 * a32 - a22 * b3);
      const detB =
        a11 * (b2 * a33 - a23 * b3) -
        b1 * (a21 * a33 - a23 * a31) +
        a13 * (a21 * b3 - b2 * a31);
      const detC =
        a11 * (a22 * b3 - b2 * a32) -
        a12 * (a21 * b3 - b2 * a31) +
        b1 * (a21 * a32 - a22 * a31);

      const A = detA / det;
      const B = detB / det;
      const C = detC / det;

      const cx = -A / 2;
      const cy = -B / 2;
      const r2 = cx * cx + cy * cy - C;
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r2) || r2 <= 0) return null;

      return { cx, cy, r: Math.sqrt(r2) };
    };

    // PRIMARY: snap to the auto-detected arc whose circle passes through the click.
    // We match against the circles ACTUALLY DRAWN in this view (canvas coords), so the
    // result lines up with exactly what the user sees on the sheet. The click lands ON
    // the visible arc, so the correct circle is the one whose (center, radius) best
    // matches the click's radial distance.
    {
      const drawn = drawnCirclesRef.current[viewType] || [];
      let bestArc = null;
      for (const circle of drawn) {
        if (!Number.isFinite(circle.cx) || !Number.isFinite(circle.cy) || !Number.isFinite(circle.r)) continue;
        if (circle.r < 6) continue;
        const distToCenter = Math.hypot(canvasX - circle.cx, canvasY - circle.cy);
        const radialErr = Math.abs(distToCenter - circle.r);
        // Tolerance for "the click is on this arc", scaled with radius.
        const tol = Math.max(28, Math.min(70, circle.r * 0.25));
        if (radialErr > tol) continue;
        // Primary criterion: smallest radial error. Tie-break slightly toward larger
        // radii so a big elbow/bend arc wins over a tiny fillet sitting underneath.
        const score = radialErr - circle.r * 0.04;
        if (!bestArc || score < bestArc.score) {
          bestArc = { x: circle.cx, y: circle.cy, radius: circle.r, score, radialErr, rmm: circle.radiusMM };
        }
      }
      if (bestArc) {
        console.log(`\u2713 Snapped to auto arc R=${bestArc.rmm.toFixed(2)}mm center=(${bestArc.x.toFixed(1)}, ${bestArc.y.toFixed(1)}), radialErr=${bestArc.radialErr.toFixed(1)}`);
        return { x: bestArc.x, y: bestArc.y, radius: bestArc.radius };
      }
      console.log(`No auto arc matched click (${canvasX.toFixed(1)}, ${canvasY.toFixed(1)}) among ${drawn.length} drawn circles in ${viewType}`);
    }

    // Fallback: fit a circle to the visible outline arc under the cursor.
    // The auto-detector misses large bend/elbow arcs, so when the user clicks on a
    // visible curve we gather nearby silhouette points and fit the circle that the arc
    // belongs to — i.e. "the centre of the whole circle if it were complete". This is a
    // deterministic algebraic fit refined by inliers (no randomness, so the same click
    // always gives the same centre).
    const viewEdges = projectedEdgesRef.current[viewType] || [];
    if (viewEdges.length > 0) {
      // Shared fit+validate helper: fits a circle to a point set, refines by inliers,
      // and checks the result is a real arc that the click actually sits on.
      const tryFit = (pts) => {
        if (!pts || pts.length < 12) return null;
        let fit = fitCircleFromPoints(pts);
        if (!fit) return null;
        for (let pass = 0; pass < 2; pass++) {
          const tol = Math.max(8, Math.min(28, fit.r * 0.12));
          const inl = pts.filter((p) => Math.abs(Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.r) <= tol);
          if (inl.length < 10) break;
          const refined = fitCircleFromPoints(inl);
          if (!refined) break;
          fit = refined;
        }
        const finalTol = Math.max(8, Math.min(28, fit.r * 0.12));
        const inliers = pts.filter((p) => Math.abs(Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.r) <= finalTol);
        const sectorCount = 16;
        const sectors = new Array(sectorCount).fill(false);
        inliers.forEach((p) => {
          const ang = Math.atan2(p.y - fit.cy, p.x - fit.cx);
          const s = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * sectorCount) % sectorCount;
          sectors[s] = true;
        });
        const sectorHits = sectors.filter(Boolean).length;
        const clickRadialErr = Math.abs(Math.hypot(fit.cx - canvasX, fit.cy - canvasY) - fit.r);
        const validRadius = fit.r > 8;
        const clickConsistent = clickRadialErr < Math.max(20, Math.min(60, fit.r * 0.22));
        const coverageOk = sectorHits >= 3;
        const enoughInliers = inliers.length >= 10;
        if (validRadius && clickConsistent && coverageOk && enoughInliers) {
          return { x: fit.cx, y: fit.cy, radius: fit.r, r: fit.r, inliers: inliers.length, total: pts.length, sectors: sectorHits, clickErr: clickRadialErr };
        }
        return { rejected: true, r: fit.r, validRadius, clickConsistent, clickErr: clickRadialErr, coverageOk, sectorHits, inliers: inliers.length };
      };

      const angleBetween = (v1, v2) => {
        const a = Math.atan2(v1.y, v1.x);
        const b = Math.atan2(v2.y, v2.x);
        let d = Math.abs(a - b);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return d;
      };

      // --- 1. Find the nearest point on any edge to the click (the arc point) ---
      let nearest = { d: Infinity, qx: canvasX, qy: canvasY };
      let nearestIdx = -1;
      viewEdges.forEach((e, i) => {
        const ax = e.p1[0], ay = e.p1[1], bx = e.p2[0], by = e.p2[1];
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy || 1e-9;
        let t = ((canvasX - ax) * dx + (canvasY - ay) * dy) / L2;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + t * dx, qy = ay + t * dy;
        const d = Math.hypot(canvasX - qx, canvasY - qy);
        if (d < nearest.d) { nearest = { d, qx, qy }; nearestIdx = i; }
      });

      let traced = null; // ordered arc points isolated by tracing the clicked curve

      if (nearestIdx >= 0 && nearest.d <= 40) {
        // --- 2. Build an endpoint adjacency graph (endpoints snapped to 1px) ---
        const nodeMap = new Map();
        const nodes = [];
        const nodeId = (x, y) => {
          const k = `${Math.round(x)},${Math.round(y)}`;
          if (nodeMap.has(k)) return nodeMap.get(k);
          const id = nodes.length;
          nodes.push({ x, y, adj: [] });
          nodeMap.set(k, id);
          return id;
        };
        const segNodes = viewEdges.map((e) => {
          const a = nodeId(e.p1[0], e.p1[1]);
          const b = nodeId(e.p2[0], e.p2[1]);
          if (a !== b) { nodes[a].adj.push(b); nodes[b].adj.push(a); }
          return [a, b];
        });

        const CORNER = Math.PI * 45 / 180; // stop tracing at sharp corners
        // Walk from node `fromId` through `curId`, always continuing along the
        // smoothest (least-turning) neighbour. Returns ordered coords starting at curId.
        const walk = (fromId, curId) => {
          const out = [];
          let prev = fromId, cur = curId, guard = 0;
          const seen = new Set([curId]);
          while (guard++ < 4000) {
            const pn = nodes[prev], cn = nodes[cur];
            out.push({ x: cn.x, y: cn.y });
            const inDir = { x: cn.x - pn.x, y: cn.y - pn.y };
            let bestNext = -1, bestTurn = Infinity;
            for (const to of cn.adj) {
              if (to === prev || seen.has(to)) continue;
              const nn = nodes[to];
              const outDir = { x: nn.x - cn.x, y: nn.y - cn.y };
              if (outDir.x === 0 && outDir.y === 0) continue;
              const turn = angleBetween(inDir, outDir);
              if (turn < bestTurn) { bestTurn = turn; bestNext = to; }
            }
            if (bestNext < 0 || bestTurn > CORNER) break;
            seen.add(bestNext);
            prev = cur; cur = bestNext;
          }
          return out;
        };

        const [n0, n1] = segNodes[nearestIdx];
        if (n0 !== n1) {
          const sideA = walk(n1, n0); // outward from the n0 end
          const sideB = walk(n0, n1); // outward from the n1 end
          const chain = [...sideA.reverse(), ...sideB];

          if (chain.length >= 6) {
            // index of the chain vertex nearest the actual click point
            let k0 = 0, k0d = Infinity;
            chain.forEach((p, i) => {
              const d = Math.hypot(p.x - nearest.qx, p.y - nearest.qy);
              if (d < k0d) { k0d = d; k0 = i; }
            });
            const turnAt = (i) => {
              if (i <= 0 || i >= chain.length - 1) return 0;
              const a = { x: chain[i].x - chain[i - 1].x, y: chain[i].y - chain[i - 1].y };
              const b = { x: chain[i + 1].x - chain[i].x, y: chain[i + 1].y - chain[i].y };
              return angleBetween(a, b);
            };
            // Grow outward from the click while the curve keeps bending; stop when it
            // straightens out (entering a tangent straight wall) for several vertices.
            const STRAIGHT = 2.5 * Math.PI / 180;
            let L = k0, R = k0, run = 0;
            for (let i = k0 + 1; i < chain.length; i++) {
              if (turnAt(i) < STRAIGHT) { if (++run >= 3) break; } else run = 0;
              R = i;
            }
            run = 0;
            for (let i = k0 - 1; i >= 0; i--) {
              if (turnAt(i) < STRAIGHT) { if (++run >= 3) break; } else run = 0;
              L = i;
            }
            const arcPts = chain.slice(L, R + 1);
            if (arcPts.length >= 12) {
              const res = tryFit(arcPts);
              if (res && !res.rejected) {
                console.log(`\u2713 Traced arc-fit center=(${res.x.toFixed(1)}, ${res.y.toFixed(1)}), r=${res.r.toFixed(1)}, pts=${arcPts.length}, inliers=${res.inliers}, sectors=${res.sectors}/16, clickErr=${res.clickErr.toFixed(1)}`);
                return { x: res.x, y: res.y, radius: res.radius };
              }
              traced = res;
            }
          }
        }
      }

      // --- 3. Fallback: windowed gather of short-edge points around the click ---
      const MAX_EDGE_LEN = 60;
      const GATHER = 320;
      const nearPts = [];
      for (const edge of viewEdges) {
        const ex1 = edge.p1[0], ey1 = edge.p1[1];
        const ex2 = edge.p2[0], ey2 = edge.p2[1];
        if (Math.hypot(ex2 - ex1, ey2 - ey1) > MAX_EDGE_LEN) continue;
        if (Math.hypot(ex1 - canvasX, ey1 - canvasY) <= GATHER) nearPts.push({ x: ex1, y: ey1 });
        if (Math.hypot(ex2 - canvasX, ey2 - canvasY) <= GATHER) nearPts.push({ x: ex2, y: ey2 });
      }
      const res = tryFit(nearPts);
      if (res && !res.rejected) {
        console.log(`\u2713 Outline arc-fit center=(${res.x.toFixed(1)}, ${res.y.toFixed(1)}), r=${res.r.toFixed(1)}, inliers=${res.inliers}/${res.total}, sectors=${res.sectors}/16, clickErr=${res.clickErr.toFixed(1)}`);
        return { x: res.x, y: res.y, radius: res.radius };
      }
      const why = res || traced;
      if (why) {
        console.log(`\u2717 Arc-fit rejected: r=${why.r?.toFixed(1)}, validRadius=${why.validRadius}, clickConsistent=${why.clickConsistent} (clickErr=${why.clickErr?.toFixed(1)}), coverageOk=${why.coverageOk} (sectors=${why.sectorHits}/16), inliers=${why.inliers}`);
      } else {
        console.log(`\u2717 Arc-fit insufficient outline points near click (need \u226512)`);
      }
    }
    
    console.log(`No auto-center found near click (${canvasX.toFixed(1)}, ${canvasY.toFixed(1)}); using manual center.`);
    return null;
  };

  // Auto-detect the angle at the corner nearest the click. We build an endpoint graph
  // of the projected edges, trace the straight runs (merging near-colinear edges) that
  // emanate from each candidate corner node, and return the vertex plus a far point
  // along each of the two arms forming the clearest corner. This lets the user click
  // once near a corner and have the angle measured automatically.
  const findCornerAngleNearPoint = (canvasX, canvasY, viewType) => {
    if (!geometry) return null;
    const viewEdges = projectedEdgesRef.current[viewType] || [];
    if (viewEdges.length < 2) return null;

    const nodeMap = new Map();
    const nodes = [];
    const nodeId = (x, y) => {
      const k = `${Math.round(x)},${Math.round(y)}`;
      if (nodeMap.has(k)) return nodeMap.get(k);
      const id = nodes.length;
      nodes.push({ x, y, adj: [] });
      nodeMap.set(k, id);
      return id;
    };
    viewEdges.forEach((e) => {
      const a = nodeId(e.p1[0], e.p1[1]);
      const b = nodeId(e.p2[0], e.p2[1]);
      if (a !== b) { nodes[a].adj.push(b); nodes[b].adj.push(a); }
    });

    const angleBetween = (v1, v2) => {
      const a = Math.atan2(v1.y, v1.x);
      const b = Math.atan2(v2.y, v2.x);
      let d = Math.abs(a - b);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return d;
    };

    // Walk a straight run from `startId` (away from `fromId`) through near-colinear
    // edges; returns the far endpoint, total length, and overall direction.
    const STRAIGHT = 12 * Math.PI / 180;
    const traceStraight = (fromId, startId) => {
      let prev = fromId, cur = startId, len = 0, guard = 0;
      const seen = new Set([startId, fromId]);
      const origin = nodes[fromId];
      while (guard++ < 4000) {
        const pn = nodes[prev], cn = nodes[cur];
        len += Math.hypot(cn.x - pn.x, cn.y - pn.y);
        const inDir = { x: cn.x - pn.x, y: cn.y - pn.y };
        let bestNext = -1, bestTurn = Infinity;
        for (const to of cn.adj) {
          if (to === prev || seen.has(to)) continue;
          const nn = nodes[to];
          const outDir = { x: nn.x - cn.x, y: nn.y - cn.y };
          if (!outDir.x && !outDir.y) continue;
          const turn = angleBetween(inDir, outDir);
          if (turn < bestTurn) { bestTurn = turn; bestNext = to; }
        }
        if (bestNext < 0 || bestTurn > STRAIGHT) break;
        seen.add(bestNext);
        prev = cur; cur = bestNext;
      }
      const end = nodes[cur];
      return { x: end.x, y: end.y, len, dir: { x: end.x - origin.x, y: end.y - origin.y } };
    };

    const SEARCH = 70; // px around the click to look for a corner node
    let best = null;
    nodes.forEach((node, id) => {
      const dClick = Math.hypot(node.x - canvasX, node.y - canvasY);
      if (dClick > SEARCH) return;
      if (node.adj.length < 2) return;
      // Trace one straight run per distinct outgoing direction.
      const runs = [];
      const usedDir = [];
      for (const to of node.adj) {
        const seed = { x: nodes[to].x - node.x, y: nodes[to].y - node.y };
        if (!seed.x && !seed.y) continue;
        if (usedDir.some((u) => angleBetween(u, seed) < STRAIGHT)) continue;
        usedDir.push(seed);
        const run = traceStraight(id, to);
        if (run.len >= 18) runs.push(run);
      }
      if (runs.length < 2) return;
      // Pick the pair of arms forming the clearest corner (12°..168°), preferring
      // long arms and corners near the click.
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          const deg = angleBetween(runs[i].dir, runs[j].dir) * 180 / Math.PI;
          if (deg < 12 || deg > 168) continue; // colinear / doubling back, not a corner
          const lenScore = Math.min(runs[i].len, runs[j].len);
          const score = dClick - lenScore * 0.15;
          if (!best || score < best.score) {
            best = {
              score,
              vertex: { x: node.x, y: node.y },
              p1: { x: runs[i].x, y: runs[i].y },
              p2: { x: runs[j].x, y: runs[j].y },
              angleDeg: deg,
            };
          }
        }
      }
    });

    if (best) {
      console.log(`\u2713 Auto angle=${best.angleDeg.toFixed(1)}\u00b0 vertex=(${best.vertex.x.toFixed(1)}, ${best.vertex.y.toFixed(1)})`);
      return best;
    }
    console.log(`No auto-angle corner found near click (${canvasX.toFixed(1)}, ${canvasY.toFixed(1)})`);
    return null;
  };

  const getCanvasCoordinates = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const rawX = (event.clientX - rect.left) * (canvas.width / rect.width);
    const rawY = (event.clientY - rect.top) * (canvas.height / rect.height);
    
    // Transform coordinates based on zoom and pan
    const x = (rawX - panOffset.x) / zoom;
    const y = (rawY - panOffset.y) / zoom;
    
    return { x, y };
  };

  const getViewTypeAtCanvasPoint = (x, y) => (
    ['front', 'top', 'sideRight', 'sideLeft'].find((viewType) => {
      if (!views[viewType]) return false;
      const bbox = viewBBoxesRef.current[viewType];
      return bbox && x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h;
    }) ?? null
  );

  // ── Scale-independent annotation anchoring ────────────────────────────────
  // Manual annotations are stored relative to their view in model units (mm from the
  // view centre) so they track scale changes and view drags. canvasToViewLocal turns a
  // visual canvas point into those local coords; viewLocalToCanvas reverses it using the
  // CURRENT scale + view position.
  const canvasToViewLocal = (viewType, px, py) => {
    const bbox = viewBBoxesRef.current[viewType];
    const s = currentScaleRef.current || 1;
    if (!bbox) return { u: 0, v: 0 };
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    return { u: (px - cx) / s, v: (cy - py) / s };
  };

  const viewLocalToCanvas = (viewType, u, v) => {
    const bbox = viewBBoxesRef.current[viewType];
    const s = currentScaleRef.current || 1;
    if (!bbox) return null;
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    return { x: cx + u * s, y: cy - v * s };
  };

  // Build the model-space anchor for a freshly created annotation.
  const makeAnnotationAnchor = (viewType, annotation) => {
    if (!viewType || !viewBBoxesRef.current[viewType]) return null;
    const L = (px, py) => canvasToViewLocal(viewType, px, py);
    switch (annotation.type) {
      case 'text': return { text: L(annotation.x, annotation.y) };
      case 'dimension': return { p1: L(annotation.x1, annotation.y1), p2: L(annotation.x2, annotation.y2) };
      case 'radius': return { center: L(annotation.centerX, annotation.centerY), edge: L(annotation.x, annotation.y) };
      case 'angle': return { p1: L(annotation.p1.x, annotation.p1.y), vertex: L(annotation.vertex.x, annotation.vertex.y), p2: L(annotation.p2.x, annotation.p2.y) };
      default: return null;
    }
  };

  // Attach a view + anchor to an annotation so it rescales. No-op if no view.
  const withAnchor = (annotation, viewType) => {
    const anchor = makeAnnotationAnchor(viewType, annotation);
    return anchor ? { ...annotation, viewType, anchor } : annotation;
  };

  // Return a copy of an annotation with its pixel fields recomputed from the anchor at
  // the current scale/view position. Legacy annotations (no anchor) are returned as-is.
  const resolveAnnotation = (annotation) => {
    const vt = annotation.viewType;
    const a = annotation.anchor;
    if (!vt || !a || !viewBBoxesRef.current[vt]) return annotation;
    const P = (loc) => viewLocalToCanvas(vt, loc.u, loc.v);
    switch (annotation.type) {
      case 'text': { const p = P(a.text); return { ...annotation, x: p.x, y: p.y }; }
      case 'dimension': { const p1 = P(a.p1); const p2 = P(a.p2); return { ...annotation, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }; }
      case 'radius': { const c = P(a.center); const e = P(a.edge); return { ...annotation, centerX: c.x, centerY: c.y, x: e.x, y: e.y }; }
      case 'angle': { const p1 = P(a.p1); const vx = P(a.vertex); const p2 = P(a.p2); return { ...annotation, p1, vertex: vx, p2 }; }
      default: return annotation;
    }
  };

  const getSnappedCanvasPoint = (point, options = {}) => {

    const viewType = options.viewType ?? getViewTypeAtCanvasPoint(point.x, point.y);
    if (!viewType) return { x: point.x, y: point.y, viewType: null };

    const snappedPoint = snapPointToEdges(point, projectedEdgesRef.current[viewType], options);
    return {
      x: snappedPoint.x,
      y: snappedPoint.y,
      viewType,
    };
  };

  const handleCanvasClick = (event) => {
    if (currentTool === 'none' || isPanning) return;
    
    const rawPoint = getCanvasCoordinates(event);
    const snapped = currentTool === 'dimension'
      ? getSnappedCanvasPoint(rawPoint, { threshold: 24, preferEndpoints: true })
      : null;
    const { x, y } = snapped ?? rawPoint;

    if (currentTool === 'text') {
      const text = prompt('Enter annotation text:');
      if (text) {
        const vt = getViewTypeAtCanvasPoint(x, y);
        setAnnotations([...annotations, withAnchor({ type: 'text', x, y, text }, vt)]);
        setCurrentTool('none');
      }
    } else if (currentTool === 'radius') {
      if (tempPoints.length === 0) {
        // First click is the arc/edge point. Auto-detect where the center of the
        // full circle would be, then create the radius dimension in a single click.
        const viewType = getViewTypeAtCanvasPoint(rawPoint.x, rawPoint.y);
        let detectedCenter = null;
        if (viewType && geometry && !event.shiftKey) {
          detectedCenter = findCircleCenterNearPoint(x, y, viewType);
        }

        if (detectedCenter) {
          // Center auto-detected from the arc the user clicked on.
          const centerX = detectedCenter.x;
          const centerY = detectedCenter.y;
          const distPx = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
          const radiusPx = detectedCenter.radius || distPx;
          // Snap the edge point onto the fitted circle along the click direction
          const dx = x - centerX;
          const dy = y - centerY;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const edgeX = centerX + (dx / len) * radiusPx;
          const edgeY = centerY + (dy / len) * radiusPx;
          const radiusMM = radiusPx / currentScaleRef.current;
          setAnnotations([...annotations, withAnchor({
            type: 'radius',
            centerX,
            centerY,
            x: edgeX,
            y: edgeY,
            value: parseFloat(radiusMM.toFixed(2))
          }, viewType)]);
          setTempPoints([]);
          setCurrentTool('none');
        } else {
          // No auto-center (or Shift held): fall back to manual two-click placement.
          if (event.shiftKey) {
            console.log('Shift-click: manual radius center placement');
          }
          setTempPoints([{ x, y, autoDetected: false }]);
        }
      } else {
        // Second click - edge point (manual mode only)
        const centerX = tempPoints[0].x;
        const centerY = tempPoints[0].y;
        const radius = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
        const radiusMM = radius / currentScaleRef.current;
        const vt = getViewTypeAtCanvasPoint(centerX, centerY);
        setAnnotations([...annotations, withAnchor({
          type: 'radius',
          centerX,
          centerY,
          x,
          y,
          value: parseFloat(radiusMM.toFixed(2))
        }, vt)]);
        setTempPoints([]);
        setCurrentTool('none');
      }
    } else if (currentTool === 'angle') {
      if (tempPoints.length === 0 && !event.shiftKey) {
        // First click: try to auto-detect the corner angle the user clicked near and
        // create the annotation in a single click.
        const viewType = getViewTypeAtCanvasPoint(rawPoint.x, rawPoint.y);
        let corner = null;
        if (viewType && geometry) {
          corner = findCornerAngleNearPoint(x, y, viewType);
        }
        if (corner) {
          setAnnotations([...annotations, withAnchor({
            type: 'angle',
            p1: corner.p1,
            vertex: corner.vertex,
            p2: corner.p2,
            value: parseFloat(corner.angleDeg.toFixed(1)),
          }, viewType)]);
          setTempPoints([]);
          setCurrentTool('none');
        } else {
          // No corner found: begin manual 3-point placement with this as point 1.
          setTempPoints([{ x, y }]);
        }
      } else {
        // Manual mode (or Shift-click): collect 3 points: first, vertex, second.
        const newPoints = [...tempPoints, { x, y }];
        if (newPoints.length === 3) {
          const [p1, vertex, p2] = newPoints;
          const angle1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x);
          const angle2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
          let angleDeg = Math.abs((angle2 - angle1) * 180 / Math.PI);
          if (angleDeg > 180) angleDeg = 360 - angleDeg;
          const vt = getViewTypeAtCanvasPoint(vertex.x, vertex.y);
          setAnnotations([...annotations, withAnchor({
            type: 'angle',
            p1,
            vertex,
            p2,
            value: parseFloat(angleDeg.toFixed(1)),
          }, vt)]);
          setTempPoints([]);
          setCurrentTool('none');
        } else {
          setTempPoints(newPoints);
        }
      }
    } else if (currentTool === 'dimension') {
      if (tempPoints.length === 0) {
        setTempPoints([{ x, y }]);
      } else {
        const [p1] = tempPoints;
        const distance = Math.sqrt((x - p1.x) ** 2 + (y - p1.y) ** 2);
        const distanceMM = distance / (currentScaleRef.current || 1);
        const value = prompt(`Measured: ${distanceMM.toFixed(2)}mm\\nEnter dimension value (or press OK to use measured):`, distanceMM.toFixed(2));
        if (value !== null && value !== '') {
          const vt = getViewTypeAtCanvasPoint(p1.x, p1.y) ?? getViewTypeAtCanvasPoint(x, y);
          setAnnotations([...annotations, withAnchor({
            type: 'dimension',
            x1: p1.x,
            y1: p1.y,
            x2: x,
            y2: y,
            value: parseFloat(value)
          }, vt)]);
        }
        setTempPoints([]);
        setMouseCanvasPos(null);
        setCurrentTool('none');
      }
    }
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const mouseX = (event.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (event.clientY - rect.top) * (canvas.height / rect.height);
    
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.5, Math.min(5, zoom * delta));
    
    // Adjust pan to zoom towards mouse position
    const scaleFactor = newZoom / zoom;
    const newPanX = mouseX - (mouseX - panOffset.x) * scaleFactor;
    const newPanY = mouseY - (mouseY - panOffset.y) * scaleFactor;
    
    setZoom(newZoom);
    setPanOffset({ x: newPanX, y: newPanY });
  };

  const handleMouseDown = (event) => {
    if (currentTool !== 'none') return;
    if (event.button === 0 || event.button === 1) {
      // Check if click lands inside any view — drag all views together
      const { x, y } = getCanvasCoordinates(event);
      const overAnyView = ['front', 'top', 'sideRight', 'sideLeft'].some(vn => {
        if (!views[vn]) return false;
        const bbox = viewBBoxesRef.current[vn];
        return bbox && x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h;
      });
      if (overAnyView) {
        draggingViewRef.current = {
          startX: x,
          startY: y,
          startOffsetX: drawingOffset.x,
          startOffsetY: drawingOffset.y,
        };
        setIsDraggingView(true);
        event.preventDefault();
        return;
      }
      // Click was on empty sheet — pan the whole canvas
      setIsPanning(true);
      setLastPanPosition({ x: event.clientX, y: event.clientY });
      event.preventDefault();
    }
  };

  const handleMouseMove = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    // Show hover snap preview for dimension/radius/angle tools
    if (currentTool !== 'none' && currentTool !== 'text') {
      const rawPoint = getCanvasCoordinates(event);
      const snapped = getSnappedCanvasPoint(rawPoint, { threshold: 24, preferEndpoints: true });
      setHoverSnapPreview(snapped);
      
      // Track mouse position for dimension tool preview line
      if (currentTool === 'dimension' && tempPoints.length > 0) {
        setMouseCanvasPos(snapped);
      }
    } else {
      setHoverSnapPreview(null);
    }

    // View drag in progress — move all views together
    if (draggingViewRef.current) {
      const { x, y } = getCanvasCoordinates(event);
      const { startX, startY, startOffsetX, startOffsetY } = draggingViewRef.current;
      const dx = x - startX;
      const dy = y - startY;
      setDrawingOffset({ x: startOffsetX + dx, y: startOffsetY + dy });
      return;
    }

    // Sheet pan in progress
    if (isPanning) {
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const deltaX = (event.clientX - lastPanPosition.x) * scaleX;
      const deltaY = (event.clientY - lastPanPosition.y) * scaleY;
      setPanOffset({ x: panOffset.x + deltaX, y: panOffset.y + deltaY });
      setLastPanPosition({ x: event.clientX, y: event.clientY });
      return;
    }

    // No drag — update cursor to hint at what's draggable
    const { x, y } = getCanvasCoordinates(event);
    const overView = ['front', 'top', 'sideRight', 'sideLeft'].some(vn => {
      if (!views[vn]) return false;
      const bbox = viewBBoxesRef.current[vn];
      return bbox && x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h;
    });
    canvas.style.cursor = overView ? 'move' : 'grab';
  };

  const handleMouseUp = () => {
    draggingViewRef.current = null;
    setIsDraggingView(false);
    setIsPanning(false);
  };
  
  const handleCanvasMouseLeave = () => {
    handleMouseUp();
    setHoverSnapPreview(null);
    setMouseCanvasPos(null);
  };
  
  const handleCanvasContextMenu = (event) => {
    event.preventDefault();
    
    const rawPoint = getCanvasCoordinates(event);
    const viewType = getViewTypeAtCanvasPoint(rawPoint.x, rawPoint.y);
    
    // Check if we clicked on any annotation (auto or manual)
    const clickThreshold = 25; // pixels
    
    // First check manual annotations
    const clickedManualIndex = annotations.findIndex((rawAnnotation) => {
      const annotation = resolveAnnotation(rawAnnotation);
      if (annotation.type === 'dimension') {
        const { x1, y1, x2, y2 } = annotation;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const perpAngle = angle + Math.PI / 2;
        const offset = 20;
        const ox1 = x1 + Math.cos(perpAngle) * offset;
        const oy1 = y1 + Math.sin(perpAngle) * offset;
        const ox2 = x2 + Math.cos(perpAngle) * offset;
        const oy2 = y2 + Math.sin(perpAngle) * offset;
        const midX = (ox1 + ox2) / 2;
        const midY = (oy1 + oy2) / 2;
        return Math.hypot(rawPoint.x - midX, rawPoint.y - midY) < clickThreshold;
      } else if (annotation.type === 'radius') {
        const midX = (annotation.centerX + annotation.x) / 2;
        const midY = (annotation.centerY + annotation.y) / 2;
        return Math.hypot(rawPoint.x - midX, rawPoint.y - midY) < clickThreshold;
      } else if (annotation.type === 'angle') {
        return Math.hypot(rawPoint.x - annotation.vertex.x, rawPoint.y - annotation.vertex.y) < clickThreshold;
      } else if (annotation.type === 'text') {
        return Math.hypot(rawPoint.x - annotation.x, rawPoint.y - annotation.y) < clickThreshold;
      }
      return false;
    });
    
    if (clickedManualIndex !== -1) {
      // Delete manual annotation
      setAnnotations(prev => prev.filter((_, i) => i !== clickedManualIndex));
      return;
    }
    
    // If no manual annotation clicked, check auto-detected annotations
    if (!viewType) return;
    const autoCircles = autoCirclesRef.current[viewType] || [];
    
    for (const circle of autoCircles) {
      if (!circle.cx_ || !circle.cy_) continue;
      
      // Calculate distance to annotation center
      const dist = Math.hypot(rawPoint.x - circle.cx_, rawPoint.y - circle.cy_);
      
      if (dist < circle.radiusMM * currentScaleRef.current + clickThreshold) {
        // Determine annotation type and create unique ID
        const circleType = getAutoCircleType(circle);
        let prefix = 'full';
        if (circleType === 'majorProfileArcs') prefix = 'arc';
        else if (circleType === 'profileRadii') prefix = 'profile';
        
        const annotationId = `${viewType}-${prefix}-${circle.key}-${circle.radiusMM.toFixed(2)}`;
        
        // Toggle visibility
        setHiddenAutoAnnotations(prev => {
          const newSet = new Set(prev);
          if (newSet.has(annotationId)) {
            newSet.delete(annotationId);
          } else {
            newSet.add(annotationId);
          }
          return newSet;
        });
        return;
      }
    }
  };

  const handleZoomIn = () => {
    const newZoom = Math.min(5, zoom * 1.2);
    setZoom(newZoom);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(0.5, zoom / 1.2);
    setZoom(newZoom);
  };

  const handleZoomReset = () => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const downloadAsPNG = () => {
    const canvas = offscreenCanvasRef.current || canvasRef.current;
    if (!canvas) return;
    
    const link = document.createElement('a');
    link.download = `${drawingName || 'drawing'}.png`;
    link.href = canvas.toDataURL('image/png', 1.0);
    link.click();
  };

  const downloadAsSVG = () => {
    const canvas = offscreenCanvasRef.current || canvasRef.current;
    if (!canvas || !geometry || !stlDimensions) return;
    
    // Get canvas as base64 image
    const imgData = canvas.toDataURL('image/png');
    
    // Create SVG with A3 dimensions and embedded canvas image
    const width = 1754;
    const height = 1240;
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image xlink:href="${imgData}" width="${width}" height="${height}" />
</svg>`;
    
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const link = document.createElement('a');
    link.download = `${drawingName || 'drawing'}.svg`;
    link.href = URL.createObjectURL(blob);
    link.click();
  };

  const downloadAsPDF = () => {
    const canvas = offscreenCanvasRef.current || canvasRef.current;
    if (!canvas) return;
    
    // A3 dimensions in mm: 420 x 297 (landscape)
    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a3'
    });
    
    // Convert canvas to image data with high quality
    const imgData = canvas.toDataURL('image/png', 1.0);
    
    // Calculate dimensions to fit A3 while maintaining aspect ratio
    const canvasAspectRatio = canvas.width / canvas.height;
    const a3Width = 420;
    const a3Height = 297;
    
    let imgWidth = a3Width;
    let imgHeight = a3Width / canvasAspectRatio;
    
    // If height exceeds A3 height, scale by height instead
    if (imgHeight > a3Height) {
      imgHeight = a3Height;
      imgWidth = a3Height * canvasAspectRatio;
    }
    
    // Center the image on the page
    const xOffset = (a3Width - imgWidth) / 2;
    const yOffset = (a3Height - imgHeight) / 2;
    
    // Add image to PDF
    pdf.addImage(imgData, 'PNG', xOffset, yOffset, imgWidth, imgHeight);
    
    // Save the PDF
    pdf.save(`${drawingName || 'drawing'}.pdf`);
  };

  const drawProjectionSymbol = (ctx, x, y, type) => {
    // Draw projection symbol (ISO standard)
    const size = 25;
    
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#000000";

    // Draw two rectangles representing the views
    // Top rectangle
    ctx.strokeRect(x, y, size, size * 0.6);
    // Side rectangle
    ctx.strokeRect(x + size * 1.2, y, size * 0.6, size);

    if (type === "third") {
      // Third-angle projection (US standard)
      // Cone in left rectangle, circle in top-right of right rectangle
      
      // Draw cone in left rectangle
      ctx.beginPath();
      ctx.moveTo(x + size * 0.25, y + size * 0.5);
      ctx.lineTo(x + size * 0.5, y + size * 0.15);
      ctx.lineTo(x + size * 0.75, y + size * 0.5);
      ctx.closePath();
      ctx.stroke();
      
      // Base of cone
      ctx.beginPath();
      ctx.ellipse(x + size * 0.5, y + size * 0.5, size * 0.25, size * 0.06, 0, 0, Math.PI * 2);
      ctx.stroke();
      
      // Draw circle in right rectangle
      ctx.beginPath();
      ctx.arc(x + size * 1.35, y + size * 0.25, size * 0.15, 0, Math.PI * 2);
      ctx.stroke();
      
    } else {
      // First-angle projection (European standard)
      // Circle in left rectangle, cone in bottom-left of right rectangle
      
      // Draw circle in left rectangle
      ctx.beginPath();
      ctx.arc(x + size * 0.5, y + size * 0.3, size * 0.15, 0, Math.PI * 2);
      ctx.stroke();
      
      // Draw cone in right rectangle
      ctx.beginPath();
      ctx.moveTo(x + size * 1.32, y + size * 0.5);
      ctx.lineTo(x + size * 1.5, y + size * 0.85);
      ctx.lineTo(x + size * 1.68, y + size * 0.5);
      ctx.closePath();
      ctx.stroke();
      
      // Base of cone
      ctx.beginPath();
      ctx.ellipse(x + size * 1.5, y + size * 0.5, size * 0.18, size * 0.05, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    ctx.restore();
  };

  const drawBorderAndTitleBlock = (ctx, canvas) => {
    const margin = 20;

    // Helper: draw text scaled down to fit within maxWidth
    const fitText = (text, x, y, maxWidth, baseFontSize = 16) => {
      let fontSize = baseFontSize;
      ctx.font = `${fontSize}px Arial`;
      while (ctx.measureText(text).width > maxWidth && fontSize > 7) {
        fontSize -= 0.5;
        ctx.font = `${fontSize}px Arial`;
      }
      ctx.fillText(text, x, y);
      ctx.font = `${baseFontSize}px Arial`; // restore
    };

    // Outer border
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, margin, canvas.width - margin * 2, canvas.height - margin * 2);

    // Title block area (bottom right)
    const tbWidth = 350;
    const tbHeight = 180;
    const tbX = canvas.width - margin - tbWidth;
    const tbY = canvas.height - margin - tbHeight;

    ctx.lineWidth = 1;
    ctx.strokeRect(tbX, tbY, tbWidth, tbHeight);

    // Horizontal lines inside title block
    ctx.beginPath();
    ctx.moveTo(tbX, tbY + 36);
    ctx.lineTo(tbX + tbWidth, tbY + 36);
    ctx.moveTo(tbX, tbY + 72);
    ctx.lineTo(tbX + tbWidth, tbY + 72);
    ctx.moveTo(tbX, tbY + 108);
    ctx.lineTo(tbX + tbWidth, tbY + 108);
    ctx.moveTo(tbX, tbY + 144);
    ctx.lineTo(tbX + tbWidth, tbY + 144);
    ctx.stroke();

    const labelX = tbX + 10;
    const valueX = tbX + 100;
    const valueMaxW = tbWidth - 100 - 10; // available space for values

    ctx.font = "16px Arial";
    ctx.fillStyle = "#000000";

    ctx.fillText("Drawing:", labelX, tbY + 23);
    fitText(drawingName || "-", valueX, tbY + 23, valueMaxW);

    ctx.fillText("Company:", labelX, tbY + 59);
    fitText(company || "-", valueX, tbY + 59, valueMaxW);

    ctx.fillText("Drawn By:", labelX, tbY + 95);
    fitText(author || "-", valueX, tbY + 95, valueMaxW);

    ctx.fillText("Date:", labelX, tbY + 131);
    fitText(drawingDate, valueX, tbY + 131, valueMaxW);

    ctx.fillText("Scale:", labelX, tbY + 167);
    fitText(drawingScale > 1 ? `${drawingScale.toFixed(1)}:1` : `1:${(1/drawingScale).toFixed(1)}`, valueX, tbY + 167, valueMaxW);

    // Draw projection symbol in bottom left corner
    drawProjectionSymbol(ctx, margin + 20, canvas.height - margin - 50, projectionType);
    
    // Add label for projection type and A3 sheet size
    ctx.font = "12px Arial";
    ctx.fillText(projectionType === "first" ? "First Angle (ISO)" : "Third Angle (ASME)", margin + 20, canvas.height - margin - 55);
    ctx.fillText("Sheet: A3", margin + 150, canvas.height - margin - 30);
  };

  // Extract and classify edges from triangles for technical drawing.
  // Works in 3D space so silhouette / feature detection is correct, then
  // projects the kept edges to 2D canvas coordinates.
  //
  // Returns an array of { p1, p2, type } where type is one of:
  //   'silhouette' – outer contour or boundary between a visible and a hidden face
  //   'feature'    – sharp crease between two visible faces (> FEATURE_ANGLE_DEG)
  const extractEdges = (positions, viewType, centerModelX, centerModelY, centerModelZ, scale, centerX, centerY) => {
    // ── view direction (toward the viewer, in model space) ──────────────────
    // front: look along +Z
    // top:   look along +Y
    // sideRight: look along -X (right side of model)
    // sideLeft:  look along +X (left side of model)
    const vx = viewType === 'sideLeft' ? 1 : viewType === 'sideRight' ? -1 : 0;
    const vy = viewType === 'top'  ? 1 : 0;
    const vz = viewType === 'front' ? 1 : 0;

    // Round 3-D coordinates to a fixed precision to merge coincident vertices
    const R = (n) => Math.round(n * 100) / 100;

    // Project a single 3-D point to 2-D canvas coords
    const project = (x, y, z) => {
      if (viewType === 'front')      return [centerX + (x - centerModelX) * scale, centerY - (y - centerModelY) * scale];
      if (viewType === 'top')        return [centerX + (x - centerModelX) * scale, centerY - (z - centerModelZ) * scale];
      if (viewType === 'sideRight')  return [centerX - (z - centerModelZ) * scale, centerY - (y - centerModelY) * scale];
      /* sideLeft */                 return [centerX + (z - centerModelZ) * scale, centerY - (y - centerModelY) * scale];
    };

    // edge map: 3-D key → { p1, p2, normals[], faces[] }
    const edgeMap = new Map();

    const totalTris = Math.floor(positions.length / 9);
    for (let i = 0; i < totalTris; i++) {
      const b = i * 9;
      const x0 = positions[b],   y0 = positions[b+1], z0 = positions[b+2];
      const x1 = positions[b+3], y1 = positions[b+4], z1 = positions[b+5];
      const x2 = positions[b+6], y2 = positions[b+7], z2 = positions[b+8];

      // Face normal (cross product of two edges) — not normalised yet
      const ex = x1-x0, ey = y1-y0, ez = z1-z0;
      const fx = x2-x0, fy = y2-y0, fz = z2-z0;
      const nx = ey*fz - ez*fy;
      const ny = ez*fx - ex*fz;
      const nz = ex*fy - ey*fx;
      const nlen = Math.sqrt(nx*nx + ny*ny + nz*nz);

      // Is this face front-facing relative to the view direction?
      const isFront = nlen > 0 && (nx*vx + ny*vy + nz*vz) > 0;

      // Vertices for the three edges of this triangle
      const verts = [
        [x0,y0,z0, x1,y1,z1],
        [x1,y1,z1, x2,y2,z2],
        [x2,y2,z2, x0,y0,z0],
      ];

      for (const [ax,ay,az, bx,by,bz] of verts) {
        const rax=R(ax), ray=R(ay), raz=R(az);
        const rbx=R(bx), rby=R(by), rbz=R(bz);

        // Build a canonical (sorted) 3-D key so each edge is stored once
        const swapped = rax > rbx || (rax===rbx && ray > rby) || (rax===rbx && ray===rby && raz > rbz);
        const key = swapped
          ? `${rbx},${rby},${rbz}|${rax},${ray},${raz}`
          : `${rax},${ray},${raz}|${rbx},${rby},${rbz}`;

        if (!edgeMap.has(key)) {
          const [px1, py1] = project(ax, ay, az);
          const [px2, py2] = project(bx, by, bz);
          edgeMap.set(key, { p1:[px1,py1], p2:[px2,py2], normals:[{nx,ny,nz,nlen}], faces:[isFront] });
        } else {
          const e = edgeMap.get(key);
          e.normals.push({ nx, ny, nz, nlen });
          e.faces.push(isFront);
        }
      }
    }

    // ── Classify edges ───────────────────────────────────────────────────────
    // A crease is drawn when the dihedral angle between two faces is > threshold
    const FEATURE_COS = Math.cos(Math.PI * 30 / 180); // 30 °

    const result = [];
    edgeMap.forEach(edge => {
      const { faces, normals } = edge;
      const count = faces.length;

      if (count === 1) {
        // Naked / boundary edge — always visible
        result.push({ p1: edge.p1, p2: edge.p2, type: 'silhouette' });
      } else if (count === 2) {
        const [f1, f2] = faces;
        if (f1 !== f2) {
          // Silhouette: one face toward viewer, one away
          result.push({ p1: edge.p1, p2: edge.p2, type: 'silhouette' });
        } else if (f1) {
          // Both front-facing — only draw if it's a visible crease
          const n1 = normals[0], n2 = normals[1];
          if (n1.nlen > 0 && n2.nlen > 0) {
            const dot = (n1.nx*n2.nx + n1.ny*n2.ny + n1.nz*n2.nz) / (n1.nlen * n2.nlen);
            if (dot < FEATURE_COS) {
              result.push({ p1: edge.p1, p2: edge.p2, type: 'feature' });
            }
          }
        }
        // Both back-facing and smooth → invisible, skip
      } else {
        // Non-manifold edge (>2 faces) — treat as a feature/boundary line
        const hasFront = faces.some(f => f);
        if (hasFront) {
          result.push({ p1: edge.p1, p2: edge.p2, type: 'feature' });
        }
      }
    });

    return result;
  };

  const drawProjection = (ctx, geom, bbox, viewType, offsetX, offsetY, viewWidth, viewHeight, scale) => {
    const positions = geom.attributes.position.array;
    const centerModelX = (bbox.max.x + bbox.min.x) / 2;
    const centerModelY = (bbox.max.y + bbox.min.y) / 2;
    const centerModelZ = (bbox.max.z + bbox.min.z) / 2;

    const centerX = offsetX + viewWidth / 2;
    const centerY = offsetY + viewHeight / 2;

    // Extract all edges from the triangles
    const edges = extractEdges(positions, viewType, centerModelX, centerModelY, centerModelZ, scale, centerX, centerY);
    projectedEdgesRef.current[viewType] = edges;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // First pass: feature / crease edges — medium weight, dark grey
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 1;
    edges.forEach(edge => {
      if (edge.type === 'feature') {
        const [x1, y1] = edge.p1;
        const [x2, y2] = edge.p2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    });

    // Second pass: silhouette / boundary edges — thick, solid black (the visible outline)
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    edges.forEach(edge => {
      if (edge.type === 'silhouette') {
        const [x1, y1] = edge.p1;
        const [x2, y2] = edge.p2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    });

    return { centerX, centerY };
  };

  const drawAnnotations = (ctx) => {
    annotations.forEach((rawAnnotation) => {
      const annotation = resolveAnnotation(rawAnnotation);
      ctx.strokeStyle = '#FF0000';
      ctx.fillStyle = '#FF0000';
      ctx.lineWidth = 1.5;
      ctx.font = '14px Arial';

      if (annotation.type === 'text') {
        ctx.fillText(annotation.text, annotation.x, annotation.y);
      } else if (annotation.type === 'radius') {
        // Draw radius line
        ctx.beginPath();
        ctx.arc(annotation.centerX, annotation.centerY, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(annotation.centerX, annotation.centerY);
        ctx.lineTo(annotation.x, annotation.y);
        ctx.stroke();
        
        // Draw arrow at edge
        const angle = Math.atan2(annotation.y - annotation.centerY, annotation.x - annotation.centerX);
        const arrowSize = 8;
        ctx.beginPath();
        ctx.moveTo(annotation.x, annotation.y);
        ctx.lineTo(
          annotation.x - arrowSize * Math.cos(angle - Math.PI / 6),
          annotation.y - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(annotation.x, annotation.y);
        ctx.lineTo(
          annotation.x - arrowSize * Math.cos(angle + Math.PI / 6),
          annotation.y - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
        
        // Draw text
        const midX = (annotation.centerX + annotation.x) / 2;
        const midY = (annotation.centerY + annotation.y) / 2;
        ctx.fillText(`R ${annotation.value}`, midX + 5, midY - 5);
      } else if (annotation.type === 'angle') {
        // Draw angle arc
        const { vertex, p1, p2, value } = annotation;
        const angle1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x);
        const angle2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
        const radius = 30;
        
        ctx.beginPath();
        ctx.arc(vertex.x, vertex.y, radius, angle1, angle2);
        ctx.stroke();
        
        // Draw lines
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(vertex.x, vertex.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.moveTo(vertex.x, vertex.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw text
        const midAngle = (angle1 + angle2) / 2;
        const textX = vertex.x + Math.cos(midAngle) * (radius + 15);
        const textY = vertex.y + Math.sin(midAngle) * (radius + 15);
        ctx.fillText(`${value}°`, textX, textY);
      } else if (annotation.type === 'dimension') {
        // Draw dimension line with arrows
        const { x1, y1, x2, y2, value } = annotation;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const offset = 20;
        
        // Offset line perpendicular to dimension
        const perpAngle = angle + Math.PI / 2;
        const ox1 = x1 + Math.cos(perpAngle) * offset;
        const oy1 = y1 + Math.sin(perpAngle) * offset;
        const ox2 = x2 + Math.cos(perpAngle) * offset;
        const oy2 = y2 + Math.sin(perpAngle) * offset;
        
        // Extension lines
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(ox1, oy1);
        ctx.moveTo(x2, y2);
        ctx.lineTo(ox2, oy2);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Dimension line
        ctx.beginPath();
        ctx.moveTo(ox1, oy1);
        ctx.lineTo(ox2, oy2);
        ctx.stroke();
        
        // Arrows
        const arrowSize = 8;
        ctx.beginPath();
        ctx.moveTo(ox1, oy1);
        ctx.lineTo(
          ox1 + arrowSize * Math.cos(angle + Math.PI * 5 / 6),
          oy1 + arrowSize * Math.sin(angle + Math.PI * 5 / 6)
        );
        ctx.moveTo(ox1, oy1);
        ctx.lineTo(
          ox1 + arrowSize * Math.cos(angle - Math.PI * 5 / 6),
          oy1 + arrowSize * Math.sin(angle - Math.PI * 5 / 6)
        );
        ctx.moveTo(ox2, oy2);
        ctx.lineTo(
          ox2 + arrowSize * Math.cos(angle + Math.PI / 6),
          oy2 + arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.moveTo(ox2, oy2);
        ctx.lineTo(
          ox2 + arrowSize * Math.cos(angle - Math.PI / 6),
          oy2 + arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.stroke();
        
        // Text
        const midX = (ox1 + ox2) / 2;
        const midY = (oy1 + oy2) / 2;
        ctx.fillText(value.toString(), midX + 5, midY - 5);
      }
    });
  };

  // ── 3D preview (pure canvas2D, no WebGLRenderer) ──────────────────────────
  const draw3DPreview = () => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !geometry) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, W, H);

    // Apply user rotation + fixed isometric tilt using Three.js matrix math only
    const prevGeom = getPreview3DGeometry(geometry, liveRotationRef.current);
    const bbox = prevGeom.boundingBox;
    const maxDim = Math.max(
      bbox.max.x - bbox.min.x,
      bbox.max.y - bbox.min.y,
      bbox.max.z - bbox.min.z
    );
    if (maxDim === 0) return;

    const scale = (Math.min(W, H) * 0.65) / maxDim;
    const cx = (bbox.max.x + bbox.min.x) / 2;
    const cy = (bbox.max.y + bbox.min.y) / 2;
    const cz = (bbox.max.z + bbox.min.z) / 2;

    let posArray = prevGeom.attributes.position.array;

    // Subsample large models so dragging stays smooth
    const MAX_TRIS = 8000;
    const totalTris = posArray.length / 9;
    if (totalTris > MAX_TRIS) {
      const step = Math.ceil(totalTris / MAX_TRIS);
      const sampled = [];
      for (let i = 0; i < posArray.length; i += 9 * step) {
        for (let j = 0; j < 9 && i + j < posArray.length; j++) {
          sampled.push(posArray[i + j]);
        }
      }
      posArray = new Float32Array(sampled);
    }

    // Reuse existing extractEdges with 'front' projection (XY plane of tilt-rotated geom)
    const edges = extractEdges(posArray, 'front', cx, cy, cz, scale, W / 2, H / 2);

    ctx.strokeStyle = 'rgba(80, 200, 255, 0.65)';
    ctx.lineWidth = 0.7;
    ctx.lineCap = 'round';
    edges.forEach(edge => {
      ctx.beginPath();
      ctx.moveTo(edge.p1[0], edge.p1[1]);
      ctx.lineTo(edge.p2[0], edge.p2[1]);
      ctx.stroke();
    });

    // Help text
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Drag to rotate  ·  use Z slider for roll', W / 2, H - 8);
    ctx.textAlign = 'left';
  };

  // Mouse handlers — update refs only during drag, commit state on release
  const handle3DMouseDown = (e) => {
    e.preventDefault();
    isDragging3DRef.current = true;
    lastDragPos3DRef.current = { x: e.clientX, y: e.clientY };
    if (previewCanvasRef.current) previewCanvasRef.current.style.cursor = 'grabbing';
  };

  const handle3DMouseMove = (e) => {
    if (!isDragging3DRef.current) return;
    const dx = e.clientX - lastDragPos3DRef.current.x;
    const dy = e.clientY - lastDragPos3DRef.current.y;
    liveRotationRef.current = {
      x: Math.max(-180, Math.min(180, liveRotationRef.current.x + dy * 0.5)),
      y: Math.max(-180, Math.min(180, liveRotationRef.current.y + dx * 0.5)),
      z: liveRotationRef.current.z,
    };
    lastDragPos3DRef.current = { x: e.clientX, y: e.clientY };
    draw3DPreview(); // paint preview instantly without state update
  };

  // On release: commit rotation → triggers 2D redraw exactly once
  const handle3DMouseUp = () => {
    if (!isDragging3DRef.current) return;
    isDragging3DRef.current = false;
    if (previewCanvasRef.current) previewCanvasRef.current.style.cursor = 'grab';
    setRotation({ ...liveRotationRef.current });
  };

  // Touch equivalents
  const handle3DTouchStart = (e) => {
    const touch = e.touches[0];
    isDragging3DRef.current = true;
    lastDragPos3DRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handle3DTouchMove = (e) => {
    if (!isDragging3DRef.current || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - lastDragPos3DRef.current.x;
    const dy = touch.clientY - lastDragPos3DRef.current.y;
    liveRotationRef.current = {
      x: Math.max(-180, Math.min(180, liveRotationRef.current.x + dy * 0.5)),
      y: Math.max(-180, Math.min(180, liveRotationRef.current.y + dx * 0.5)),
      z: liveRotationRef.current.z,
    };
    lastDragPos3DRef.current = { x: touch.clientX, y: touch.clientY };
    draw3DPreview();
  };

  const handle3DTouchEnd = () => {
    if (!isDragging3DRef.current) return;
    isDragging3DRef.current = false;
    setRotation({ ...liveRotationRef.current });
  };
  // ─────────────────────────────────────────────────────────────────────────

  const draw2D = (geom) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rotatedGeom = getRotatedGeometry(geom, rotation);    rotatedGeom.computeBoundingBox();
    const width = rotatedGeom.boundingBox.max.x - rotatedGeom.boundingBox.min.x;
    const height = rotatedGeom.boundingBox.max.y - rotatedGeom.boundingBox.min.y;
    const depth = rotatedGeom.boundingBox.max.z - rotatedGeom.boundingBox.min.z;

    // Create or get offscreen canvas for rendering
    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
      offscreenCanvasRef.current.width = canvas.width;
      offscreenCanvasRef.current.height = canvas.height;
    }
    
    const offscreenCanvas = offscreenCanvasRef.current;
    const offscreenCtx = offscreenCanvas.getContext("2d", { alpha: false });
    
    // Enable better rendering
    offscreenCtx.imageSmoothingEnabled = true;
    offscreenCtx.imageSmoothingQuality = 'high';
    
    offscreenCtx.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
    
    // Fill white background
    offscreenCtx.fillStyle = "#ffffff";
    offscreenCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
    projectedEdgesRef.current = createEmptyAutoCircles();

    drawBorderAndTitleBlock(offscreenCtx, offscreenCanvas);

    const margin = 80;
    const usableWidth = canvas.width - margin * 2;
    const usableHeight = canvas.height - margin * 2 - 200;

    // Count active views
    const activeViews = Object.values(views).filter(v => v).length;
    if (activeViews === 0) return;

    const viewSpacing = 40;
    let viewWidth, viewHeight;
    
    // Layout sizing
    // Third angle (ASME): top view ABOVE front, side-right to the RIGHT, side-left to the LEFT (beyond right)
    // First angle (ISO):  top view BELOW front, side-right to the LEFT, side-left to the RIGHT (beyond left)
    const isThird = projectionType === 'third';

    // Auto-fit: calculate grid dimensions from the number of column/row slots needed
    const numCols = (views.sideRight && views.sideLeft) ? 3
                  : (views.sideRight || views.sideLeft) ? 2
                  : 1;
    const numRows = views.top ? 2 : 1;
    viewWidth  = (usableWidth  - (numCols - 1) * viewSpacing) / numCols;
    viewHeight = (usableHeight - (numRows - 1) * viewSpacing) / numRows;

    const maxDim = Math.max(width, height, depth);
    let scale;
    
    if (useManualScale && manualScale) {
      // Use manual scale if enabled
      const parsedScale = parseFloat(manualScale);
      scale = isNaN(parsedScale) || parsedScale <= 0 || !isFinite(parsedScale) ? 1 : parsedScale;
    } else {
      // Auto-calculate scale
      const autoScale = Math.min(viewWidth / maxDim, viewHeight / maxDim) * 0.7;
      scale = isFinite(autoScale) && autoScale > 0 ? autoScale : 1;
    }
    
    // Calculate and store the drawing scale (model to drawing ratio)
    setDrawingScale(scale);
    currentScaleRef.current = scale;

    const overallDimensionHosts = getOverallDimensionHosts(views);
    const drawVerticalViewLabel = (ctx, text, x, y) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };

    offscreenCtx.font = "20px Arial";
    offscreenCtx.fillStyle = "#000000";

    const startX = margin;
    const startY = margin;

    if (rotatedGeom) {
      const bbox = rotatedGeom.boundingBox;
      const centerModelX = (bbox.max.x + bbox.min.x) / 2;
      const centerModelY = (bbox.max.y + bbox.min.y) / 2;
      const centerModelZ = (bbox.max.z + bbox.min.z) / 2;
      const primaryMajorArcViewByCircle = buildPrimaryMajorArcViewMap(autoCirclesRef.current, views, showSideViewDetails);

      // Helper: project and draw auto-detected circles for a single view using current layout
      const drawAutoCirclesInView = (ctx, viewType, vcx, vcy) => {
        // Side-view details are optional because they can add clutter on some parts.
        drawnCirclesRef.current[viewType] = [];
        if (isSideView(viewType) && !showSideViewDetails) return;
        const projectModelPoint = (mx, my, mz) => {
          if (viewType === 'front') {
            return {
              x: vcx + (mx - centerModelX) * scale,
              y: vcy - (my - centerModelY) * scale,
            };
          }
          if (viewType === 'top') {
            return {
              x: vcx + (mx - centerModelX) * scale,
              y: vcy - (mz - centerModelZ) * scale,
            };
          }
          if (viewType === 'sideRight') {
            return {
              x: vcx - (mz - centerModelZ) * scale,
              y: vcy - (my - centerModelY) * scale,
            };
          }
          return {
            x: vcx + (mz - centerModelZ) * scale,
            y: vcy - (my - centerModelY) * scale,
          };
        };
        const circles = Object.entries(autoCirclesRef.current).flatMap(([sourceView, sourceCircles]) =>
          sourceCircles.filter((circle) => {
            const circleType = getAutoCircleType(circle);
            if (!autoDetectionFilters[circleType]) return false;
            if (circleType === 'majorProfileArcs') {
              return primaryMajorArcViewByCircle.get(circle) === viewType;
            }
            const hostViews = circleType === 'profileRadii'
              ? getProfileRadiiHostViews(sourceView, profileRadiiViews, views, showSideViewDetails)
              : [sourceView];
            return hostViews.includes(viewType);
          })
        );
        circleDebugLog(`[drawAutoCirclesInView] viewType=${viewType} circles=${circles.length} showAnnotations=${showAnnotations} vcx=${vcx?.toFixed(1)} vcy=${vcy?.toFixed(1)}`);
        if (circles.length > 0) circleDebugLog(`  centerModelX=${centerModelX?.toFixed(1)} centerModelY=${centerModelY?.toFixed(1)} scale=${scale?.toFixed(3)} circles:`, JSON.stringify(circles));
        if (circles.length === 0 || !showAnnotations) return;
        const projectedCircles = circles.map((circle) => {
          const centerPoint = projectModelPoint(circle.meanMX, circle.meanMY, circle.meanMZ);
          const surfacePoint = projectModelPoint(
            circle.surfaceMX ?? circle.meanMX,
            circle.surfaceMY ?? circle.meanMY,
            circle.surfaceMZ ?? circle.meanMZ,
          );
          const gapStartPoint = Number.isFinite(circle.gapStartMX)
            ? projectModelPoint(circle.gapStartMX, circle.gapStartMY, circle.gapStartMZ)
            : null;
          const gapEndPoint = Number.isFinite(circle.gapEndMX)
            ? projectModelPoint(circle.gapEndMX, circle.gapEndMY, circle.gapEndMZ)
            : null;
          const cx_ = centerPoint.x;
          const cy_ = centerPoint.y;
          let gx, gy;
          if (viewType === 'front') {
            gx = circle.meanMX;
            gy = circle.meanMY;
          } else if (viewType === 'top') {
            gx = circle.meanMX;
            gy = circle.meanMZ;
          } else {
            gx = circle.meanMZ;
            gy = circle.meanMY;
          }
          return {
            ...circle,
            circleType: getAutoCircleType(circle),
            cx_,
            cy_,
            r: circle.radiusMM * scale,
            gapStartX_: gapStartPoint?.x ?? null,
            gapStartY_: gapStartPoint?.y ?? null,
            gapEndX_: gapEndPoint?.x ?? null,
            gapEndY_: gapEndPoint?.y ?? null,
            sx_: surfacePoint.x,
            sy_: surfacePoint.y,
            key: `${Math.round(gx * 2)}_${Math.round(gy * 2)}`,
          };
        });
        const fullCircles = projectedCircles
          .filter(circle => circle.circleType === 'fullCircles')
          .sort((a, b) => a.key.localeCompare(b.key) || a.radiusMM - b.radiusMM);
        const majorArcMap = new Map();
        projectedCircles
          .filter(circle => circle.circleType === 'majorProfileArcs')
          .forEach((circle) => {
            const existing = majorArcMap.get(`${circle.key}_${Math.round(circle.radiusMM * 5)}`);
            const quality = circle.rSectors - circle.rGap;
            const existingQuality = existing ? existing.rSectors - existing.rGap : -Infinity;
            if (!existing || quality > existingQuality || (quality === existingQuality && circle.rSectors > existing.rSectors)) {
              majorArcMap.set(`${circle.key}_${Math.round(circle.radiusMM * 5)}`, circle);
            }
          });
        const majorProfileArcs = [...majorArcMap.values()]
          .sort((a, b) => (
            a.key.localeCompare(b.key) ||
            (b.radiusMM - a.radiusMM) ||
            (getMajorProfileArcVisibilityScore(b) - getMajorProfileArcVisibilityScore(a))
          ));
        const profileCircleMap = new Map();
        projectedCircles
          .filter(circle => circle.circleType === 'profileRadii')
          .forEach((circle) => {
            const existing = profileCircleMap.get(circle.key);
            const quality = circle.rSectors - circle.rGap;
            const existingQuality = existing ? existing.rSectors - existing.rGap : -Infinity;
            if (!existing || quality > existingQuality || (quality === existingQuality && circle.radiusMM > existing.radiusMM)) {
              profileCircleMap.set(circle.key, circle);
            }
          });
        const profileCircles = [...profileCircleMap.values()];
        // Record exactly the arcs being drawn in this view (canvas coords) so the
        // manual Radius tool can snap its center to what the user sees.
        drawnCirclesRef.current[viewType] = [...fullCircles, ...majorProfileArcs, ...profileCircles].map((c) => ({
          cx: c.cx_,
          cy: c.cy_,
          r: c.r,
          radiusMM: c.radiusMM,
          circleType: c.circleType,
        }));
        const groupCounts = new Map();
        fullCircles.forEach((circle) => {
          const key = circle.key;
          groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
        });
        const groupOffsets = new Map();
        ctx.save();
        ctx.strokeStyle = '#FF0000';
        ctx.fillStyle = '#FF0000';
        ctx.lineWidth = 1.5;
        ctx.font = '14px Arial';
        const viewBounds = {
          left: vcx - viewWidth / 2 + 12,
          right: vcx + viewWidth / 2 - 12,
          top: vcy - viewHeight / 2 + 22,
          bottom: vcy + viewHeight / 2 - 22,
        };
        const occupiedRects = [];
        const labelHeight = 18;
        const labelPad = 4;
        const rectsOverlap = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        const makeLabelRect = (text, x, y, align) => {
          const width = ctx.measureText(text).width;
          let left = x;
          if (align === 'center') left = x - width / 2;
          else if (align === 'right') left = x - width;
          return {
            left: left - labelPad,
            right: left + width + labelPad,
            top: y - labelHeight / 2 - labelPad,
            bottom: y + labelHeight / 2 + labelPad,
          };
        };
        const clampLabelPosition = (text, x, y, align) => {
          const rect = makeLabelRect(text, x, y, align);
          let dx = 0;
          let dy = 0;
          if (rect.left < viewBounds.left) dx = viewBounds.left - rect.left;
          else if (rect.right > viewBounds.right) dx = viewBounds.right - rect.right;
          if (rect.top < viewBounds.top) dy = viewBounds.top - rect.top;
          else if (rect.bottom > viewBounds.bottom) dy = viewBounds.bottom - rect.bottom;
          const clampedX = x + dx;
          const clampedY = y + dy;
          return {
            x: clampedX,
            y: clampedY,
            rect: makeLabelRect(text, clampedX, clampedY, align),
          };
        };
        const getLeaderEndpoint = (sourceX, sourceY, targetX, targetY, rect, gap = 4) => {
          const expanded = {
            left: rect.left - gap,
            right: rect.right + gap,
            top: rect.top - gap,
            bottom: rect.bottom + gap,
          };
          const dx = targetX - sourceX;
          const dy = targetY - sourceY;
          const candidates = [];

          if (Math.abs(dx) > 1e-6) {
            [expanded.left, expanded.right].forEach((x) => {
              const t = (x - sourceX) / dx;
              if (t <= 0 || t >= 1) return;
              const y = sourceY + t * dy;
              if (y >= expanded.top && y <= expanded.bottom) candidates.push({ t, x, y });
            });
          }
          if (Math.abs(dy) > 1e-6) {
            [expanded.top, expanded.bottom].forEach((y) => {
              const t = (y - sourceY) / dy;
              if (t <= 0 || t >= 1) return;
              const x = sourceX + t * dx;
              if (x >= expanded.left && x <= expanded.right) candidates.push({ t, x, y });
            });
          }

          if (candidates.length === 0) return { x: targetX, y: targetY };
          candidates.sort((a, b) => a.t - b.t);
          return { x: candidates[0].x, y: candidates[0].y };
        };
        const drawAutoLabel = (text, x, y, align, rect) => {
          ctx.save();
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
          ctx.fillStyle = '#FF0000';
          ctx.textAlign = align;
          ctx.textBaseline = 'middle';
          ctx.fillText(text, x, y);
          ctx.restore();
        };
        const isRectFree = (rect) => (
          rect.left >= viewBounds.left &&
          rect.right <= viewBounds.right &&
          rect.top >= viewBounds.top &&
          rect.bottom <= viewBounds.bottom &&
          occupiedRects.every(existing => !rectsOverlap(rect, existing))
        );

        const fullLayouts = [];
        fullCircles
          .filter(circle => {
            // Apply radius filter and check if not hidden
            const isInRange = circle.radiusMM >= minRadiusFilter && circle.radiusMM <= maxRadiusFilter;
            const notHidden = !hiddenAutoAnnotations.has(`${viewType}-full-${circle.key}-${circle.radiusMM.toFixed(2)}`);
            return isInRange && notHidden;
          })
          .forEach((circle) => {
          const groupSize = groupCounts.get(circle.key) || 1;
          const groupIndex = groupOffsets.get(circle.key) || 0;
          groupOffsets.set(circle.key, groupIndex + 1);
          const label = `R ${circle.radiusMM.toFixed(2)}`;
          const r = circle.radiusMM * scale;
          const baseAngle = groupSize === 1 ? -Math.PI / 2 : (-Math.PI / 2) + (groupIndex * 2 * Math.PI / groupSize);
          const angleOffsets = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, 5 * Math.PI / 6, -5 * Math.PI / 6, Math.PI];
          const distanceOptions = [Math.max(r + 18, 28), Math.max(r + 30, 40), Math.max(r + 42, 52)];
          let chosen = null;

          for (const dist of distanceOptions) {
            for (const offset of angleOffsets) {
              const angle = baseAngle + offset;
              const textX = circle.cx_ + dist * Math.cos(angle);
              const textY = circle.cy_ + dist * Math.sin(angle);
              const align = Math.cos(angle) > 0.35 ? 'left' : Math.cos(angle) < -0.35 ? 'right' : 'center';
              const rect = makeLabelRect(label, textX, textY, align);
              if (!isRectFree(rect)) continue;
              chosen = { angle, textX, textY, align, rect };
              break;
            }
            if (chosen) break;
          }

          if (!chosen) {
            const angle = baseAngle;
            const dist = Math.max(r + 42, 52);
            const textX = circle.cx_ + dist * Math.cos(angle);
            const textY = Math.max(viewBounds.top + labelHeight / 2, Math.min(viewBounds.bottom - labelHeight / 2, circle.cy_ + dist * Math.sin(angle)));
            const align = Math.cos(angle) > 0.35 ? 'left' : Math.cos(angle) < -0.35 ? 'right' : 'center';
            chosen = { angle, textX, textY, align, rect: makeLabelRect(label, textX, textY, align) };
          }

          occupiedRects.push(chosen.rect);
          fullLayouts.push({ ...circle, label, r, ...chosen });
        });

        const majorArcGroupCounts = new Map();
        majorProfileArcs.forEach((circle) => {
          const key = circle.key;
          majorArcGroupCounts.set(key, (majorArcGroupCounts.get(key) || 0) + 1);
        });
        const majorArcGroupOffsets = new Map();
        const majorArcLayouts = [];
        majorProfileArcs
          .filter(circle => {
            const isInRange = circle.radiusMM >= minRadiusFilter && circle.radiusMM <= maxRadiusFilter;
            const notHidden = !hiddenAutoAnnotations.has(`${viewType}-arc-${circle.key}-${circle.radiusMM.toFixed(2)}`);
            return isInRange && notHidden;
          })
          .forEach((circle) => {
          const label = `R ${circle.radiusMM.toFixed(2)}`;
          const rawAngle = Math.atan2(circle.sy_ - circle.cy_, circle.sx_ - circle.cx_);
          const angle = Number.isFinite(rawAngle) ? rawAngle : -Math.PI / 2;
          const dirX = Math.cos(angle);
          const dirY = Math.sin(angle);
          const perpX = -dirY;
          const perpY = dirX;
          const groupSize = majorArcGroupCounts.get(circle.key) || 1;
          const groupIndex = majorArcGroupOffsets.get(circle.key) || 0;
          majorArcGroupOffsets.set(circle.key, groupIndex + 1);
          const stackBase = getAlternatingStackOffset(groupIndex, 18);
          const baseNormalOffset = groupIndex === 0 ? 6 : stackBase + (Math.sign(stackBase) * 6);
          const normalOffsets = [baseNormalOffset, baseNormalOffset - 10, baseNormalOffset + 10, baseNormalOffset - 20, baseNormalOffset + 20];
          const radialFractions = groupIndex === 0 ? [0.48, 0.56, 0.4] : [0.62, 0.54, 0.46];
          let chosen = null;

          for (const radialFraction of radialFractions) {
            for (const normalOffset of normalOffsets) {
              const candidate = clampLabelPosition(
                label,
                circle.cx_ + dirX * circle.r * radialFraction + perpX * normalOffset,
                circle.cy_ + dirY * circle.r * radialFraction + perpY * normalOffset,
                'center'
              );
              if (!isRectFree(candidate.rect)) continue;
              chosen = { textX: candidate.x, textY: candidate.y, align: 'center', rect: candidate.rect };
              break;
            }
            if (chosen) break;
          }

          if (!chosen) {
            const candidate = clampLabelPosition(
              label,
              circle.cx_ + dirX * circle.r * 0.52 + perpX * baseNormalOffset,
              circle.cy_ + dirY * circle.r * 0.52 + perpY * baseNormalOffset,
              'center'
            );
            chosen = { textX: candidate.x, textY: candidate.y, align: 'center', rect: candidate.rect };
          }

          occupiedRects.push(chosen.rect);
          majorArcLayouts.push({ ...circle, label, angle, ...chosen });
        });

        const gapLayouts = [];
        if (showAutoGaps) {
        majorArcLayouts.forEach((circle, index) => {
          if (
            !Number.isFinite(circle.gapWidthMM) ||
            !Number.isFinite(circle.gapStartX_) ||
            !Number.isFinite(circle.gapStartY_) ||
            !Number.isFinite(circle.gapEndX_) ||
            !Number.isFinite(circle.gapEndY_)
          ) {
            return;
          }

          const rawSpanX = circle.gapEndX_ - circle.gapStartX_;
          const rawSpanY = circle.gapEndY_ - circle.gapStartY_;
          const rawSpanLength = Math.hypot(rawSpanX, rawSpanY);
          if (rawSpanLength < 6) return;

          const snappedGapStart = snapPointToEdges(
            { x: circle.gapStartX_, y: circle.gapStartY_ },
            projectedEdgesRef.current[viewType],
            {
              threshold: Math.max(16, circle.r * 0.18),
              preferEndpoints: true,
              preferPerpendicularTo: { x: rawSpanX, y: rawSpanY },
            }
          );
          let snappedGapEnd = snapPointToEdges(
            { x: circle.gapEndX_, y: circle.gapEndY_ },
            projectedEdgesRef.current[viewType],
            {
              threshold: Math.max(16, circle.r * 0.18),
              preferEndpoints: true,
              preferPerpendicularTo: { x: rawSpanX, y: rawSpanY },
              excludeEdgeIndex: snappedGapStart.edgeIndex,
            }
          );
          if (!Number.isFinite(snappedGapEnd.distance)) {
            snappedGapEnd = snapPointToEdges(
              { x: circle.gapEndX_, y: circle.gapEndY_ },
              projectedEdgesRef.current[viewType],
              {
                threshold: Math.max(16, circle.r * 0.18),
                preferEndpoints: true,
                preferPerpendicularTo: { x: rawSpanX, y: rawSpanY },
              }
            );
          }

          const fallbackStart = {
            x: Number.isFinite(snappedGapStart.distance) ? snappedGapStart.x : circle.gapStartX_,
            y: Number.isFinite(snappedGapStart.distance) ? snappedGapStart.y : circle.gapStartY_,
          };
          const fallbackEnd = {
            x: Number.isFinite(snappedGapEnd.distance) ? snappedGapEnd.x : circle.gapEndX_,
            y: Number.isFinite(snappedGapEnd.distance) ? snappedGapEnd.y : circle.gapEndY_,
          };
          const gapStartX = fallbackStart.x;
          const gapStartY = fallbackStart.y;
          const gapEndX = fallbackEnd.x;
          const gapEndY = fallbackEnd.y;
          const spanX = gapEndX - gapStartX;
          const spanY = gapEndY - gapStartY;
          const spanLength = Math.hypot(spanX, spanY);
          if (spanLength < 6) return;

          const gapWidthMM = spanLength / scale;
          const label = `Gap ${gapWidthMM.toFixed(2)} mm`;
          let normalX = ((gapStartX + gapEndX) / 2) - circle.cx_;
          let normalY = ((gapStartY + gapEndY) / 2) - circle.cy_;
          const normalLength = Math.hypot(normalX, normalY);
          if (normalLength > 1e-6) {
            normalX /= normalLength;
            normalY /= normalLength;
          } else {
            normalX = spanY / spanLength;
            normalY = -spanX / spanLength;
          }

          let chosen = null;
          const offsetOptions = [0, 8, 16];
          for (const offset of offsetOptions) {
            const ox1 = gapStartX + normalX * offset;
            const oy1 = gapStartY + normalY * offset;
            const ox2 = gapEndX + normalX * offset;
            const oy2 = gapEndY + normalY * offset;
            const candidate = clampLabelPosition(
              label,
              (ox1 + ox2) / 2 + normalX * 8,
              (oy1 + oy2) / 2 + normalY * 8,
              'center'
            );
            if (!isRectFree(candidate.rect)) continue;
            chosen = { ox1, oy1, ox2, oy2, textX: candidate.x, textY: candidate.y, align: 'center', rect: candidate.rect };
            break;
          }

          if (!chosen) {
            const offset = offsetOptions[offsetOptions.length - 1];
            const ox1 = gapStartX + normalX * offset;
            const oy1 = gapStartY + normalY * offset;
            const ox2 = gapEndX + normalX * offset;
            const oy2 = gapEndY + normalY * offset;
            const candidate = clampLabelPosition(
              label,
              (ox1 + ox2) / 2 + normalX * 8,
              (oy1 + oy2) / 2 + normalY * 8,
              'center'
            );
            chosen = { ox1, oy1, ox2, oy2, textX: candidate.x, textY: candidate.y, align: 'center', rect: candidate.rect };
          }

          occupiedRects.push(chosen.rect);
          gapLayouts.push({ ...circle, label, gapStartX, gapStartY, gapEndX, gapEndY, ...chosen });
        });
        }

        const profileSides = { left: [], right: [] };
        profileCircles
          .filter(circle => {
            const isInRange = circle.radiusMM >= minRadiusFilter && circle.radiusMM <= maxRadiusFilter;
            const notHidden = !hiddenAutoAnnotations.has(`${viewType}-profile-${circle.key}-${circle.radiusMM.toFixed(2)}`);
            return isInRange && notHidden;
          })
          .slice()
          .sort((a, b) => a.sy_ - b.sy_ || a.sx_ - b.sx_)
          .forEach((circle) => {
            const side = circle.sx_ < vcx ? 'left' : 'right';
            profileSides[side].push(circle);
          });

        const profileLayout = new Map();
        const layoutProfileSide = (side, items) => {
          if (items.length === 0) return;
          const minGap = 22;
          const align = 'center';
          let nextY = viewBounds.top + labelHeight / 2;

          items.forEach((circle) => {
            const label = `R ${circle.radiusMM.toFixed(2)}`;
            const dx = circle.sx_ - vcx;
            const dy = circle.sy_ - vcy;
            const dist = Math.hypot(dx, dy);
            const angle = Math.atan2(dy, dx);
            const dirX = dist > 1 ? dx / dist : (side === 'left' ? -1 : 1);
            const dirY = dist > 1 ? dy / dist : 0;
            
            const desiredY = Math.max(viewBounds.top + labelHeight / 2, Math.min(viewBounds.bottom - labelHeight / 2, circle.sy_));
            const startY = Math.max(desiredY, nextY);
            const candidateYs = [];
            for (let step = 0; step < 12; step++) {
              candidateYs.push(startY + step * minGap);
              if (step > 0) candidateYs.push(startY - step * minGap);
            }

            let chosen = null;
            const leaderOffsets = [20, 30, 40, 50];
            for (const offset of leaderOffsets) {
              for (const rawY of candidateYs) {
                const textY = Math.max(viewBounds.top + labelHeight / 2, Math.min(viewBounds.bottom - labelHeight / 2, rawY));
                const textX = circle.sx_ + dirX * offset;
                const rect = makeLabelRect(label, textX, textY, align);
                if (!isRectFree(rect)) continue;
                chosen = { side, textX, textY, align, label, rect, angle };
                break;
              }
              if (chosen) break;
            }

            if (!chosen) {
              const textY = Math.max(viewBounds.top + labelHeight / 2, Math.min(viewBounds.bottom - labelHeight / 2, startY));
              const textX = circle.sx_ + dirX * 25;
              chosen = { side, textX, textY, align, label, rect: makeLabelRect(label, textX, textY, align), angle };
            }

            occupiedRects.push(chosen.rect);
            nextY = chosen.rect.bottom + 4;
            profileLayout.set(circle, chosen);
          });
        };
        layoutProfileSide('left', profileSides.left);
        layoutProfileSide('right', profileSides.right);

        fullLayouts.forEach((circle) => {
          const ex = circle.cx_ + circle.r * Math.cos(circle.angle);
          const ey = circle.cy_ + circle.r * Math.sin(circle.angle);
          const lineEnd = getLeaderEndpoint(ex, ey, circle.textX, circle.textY, circle.rect);

          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(lineEnd.x, lineEnd.y);
          ctx.stroke();

          const arrowAngle = Math.atan2(ey - circle.cy_, ex - circle.cx_);
          const arrowSize = 8;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - arrowSize * Math.cos(arrowAngle - Math.PI / 6), ey - arrowSize * Math.sin(arrowAngle - Math.PI / 6));
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - arrowSize * Math.cos(arrowAngle + Math.PI / 6), ey - arrowSize * Math.sin(arrowAngle + Math.PI / 6));
          ctx.stroke();

          drawAutoLabel(circle.label, circle.textX, circle.textY, circle.align, circle.rect);
        });
        const drawnMajorArcCenters = new Set();
        majorArcLayouts.forEach((circle) => {
          if (!drawnMajorArcCenters.has(circle.key)) {
            ctx.beginPath();
            ctx.arc(circle.cx_, circle.cy_, 3, 0, Math.PI * 2);
            ctx.fill();
            drawnMajorArcCenters.add(circle.key);
          }

          ctx.beginPath();
          ctx.moveTo(circle.cx_, circle.cy_);
          ctx.lineTo(circle.sx_, circle.sy_);
          ctx.stroke();

          const arrowSize = 8;
          ctx.beginPath();
          ctx.moveTo(circle.sx_, circle.sy_);
          ctx.lineTo(
            circle.sx_ - arrowSize * Math.cos(circle.angle - Math.PI / 6),
            circle.sy_ - arrowSize * Math.sin(circle.angle - Math.PI / 6)
          );
          ctx.moveTo(circle.sx_, circle.sy_);
          ctx.lineTo(
            circle.sx_ - arrowSize * Math.cos(circle.angle + Math.PI / 6),
            circle.sy_ - arrowSize * Math.sin(circle.angle + Math.PI / 6)
          );
          ctx.stroke();

          drawAutoLabel(circle.label, circle.textX, circle.textY, circle.align, circle.rect);
        });
        gapLayouts.forEach((circle) => {
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(circle.gapStartX, circle.gapStartY);
          ctx.lineTo(circle.ox1, circle.oy1);
          ctx.moveTo(circle.gapEndX, circle.gapEndY);
          ctx.lineTo(circle.ox2, circle.oy2);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          ctx.moveTo(circle.ox1, circle.oy1);
          ctx.lineTo(circle.ox2, circle.oy2);
          ctx.stroke();

          const angle = Math.atan2(circle.oy2 - circle.oy1, circle.ox2 - circle.ox1);
          const arrowSize = 5;
          ctx.beginPath();
          ctx.moveTo(circle.ox1, circle.oy1);
          ctx.lineTo(
            circle.ox1 + arrowSize * Math.cos(angle + Math.PI * 5 / 6),
            circle.oy1 + arrowSize * Math.sin(angle + Math.PI * 5 / 6)
          );
          ctx.moveTo(circle.ox1, circle.oy1);
          ctx.lineTo(
            circle.ox1 + arrowSize * Math.cos(angle - Math.PI * 5 / 6),
            circle.oy1 + arrowSize * Math.sin(angle - Math.PI * 5 / 6)
          );
          ctx.moveTo(circle.ox2, circle.oy2);
          ctx.lineTo(
            circle.ox2 + arrowSize * Math.cos(angle + Math.PI / 6),
            circle.oy2 + arrowSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.moveTo(circle.ox2, circle.oy2);
          ctx.lineTo(
            circle.ox2 + arrowSize * Math.cos(angle - Math.PI / 6),
            circle.oy2 + arrowSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.stroke();
          ctx.restore();

          drawAutoLabel(circle.label, circle.textX, circle.textY, circle.align, circle.rect);
        });
        profileCircles.forEach((circle) => {
          const layout = profileLayout.get(circle);
          if (!layout) return;
          const anchorX = circle.sx_;
          const anchorY = circle.sy_;
          const leaderEnd = getLeaderEndpoint(anchorX, anchorY, layout.textX, layout.textY, layout.rect);

          ctx.beginPath();
          ctx.arc(anchorX, anchorY, 3, 0, Math.PI * 2);
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(anchorX, anchorY);
          ctx.lineTo(leaderEnd.x, leaderEnd.y);
          ctx.stroke();

          drawAutoLabel(layout.label, layout.textX, layout.textY, layout.align, layout.rect);
        });
        ctx.restore();
      };

      // Projection layout:
      // First angle  (ISO): top BELOW front, right-side LEFT of front,  left-side RIGHT of front
      // Third angle (ASME): top ABOVE front, right-side RIGHT of front, left-side LEFT  of front
      //
      // In third angle the front row is pushed down to make room for the top view above it.
      const frontRowY = isThird ? startY + viewHeight + viewSpacing : startY;
      const topRowY   = isThird ? startY : startY + viewHeight + viewSpacing;

      // Shift front right if a view needs to sit to its left:
      //   First angle: right-side sits LEFT → shift right if sideRight enabled
      //   Third angle: left-side sits LEFT  → shift right if sideLeft  enabled
      const needsLeftRoom = isThird ? views.sideLeft : views.sideRight;
      const frontColX = startX + (needsLeftRoom ? viewWidth + viewSpacing : 0);

      const rightSideColX = isThird
        ? frontColX + viewWidth + viewSpacing   // right of front
        : frontColX - viewWidth - viewSpacing;  // left  of front
      const leftSideColX = isThird
        ? frontColX - viewWidth - viewSpacing   // left  of front
        : frontColX + viewWidth + viewSpacing;  // right of front

      // Front View
      if (views.front) {
        const posX = frontColX + drawingOffset.x;
        const posY = frontRowY + drawingOffset.y;
        viewBBoxesRef.current.front = { x: posX, y: posY, w: viewWidth, h: viewHeight };
        
        offscreenCtx.fillText("Front View (XY)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'front', posX, posY, viewWidth, viewHeight, scale);
        drawAutoCirclesInView(offscreenCtx, 'front', centerX, centerY);
        
        const rectW = width * scale;
        const rectH = height * scale;
        if (dimensions.width && overallDimensionHosts.width === 'front') {
          offscreenCtx.fillText(`W: ${width.toFixed(1)} mm`, centerX - rectW / 2, centerY + rectH / 2 + 20);
        }
        if (dimensions.height && overallDimensionHosts.height === 'front') {
          const hOnRight = needsLeftRoom;
          drawVerticalViewLabel(offscreenCtx, `H: ${height.toFixed(1)} mm`, hOnRight ? centerX + rectW / 2 + 50 : centerX - rectW / 2 - 50, centerY);
        }
      }

      // Top View
      if (views.top) {
        const posX = frontColX + drawingOffset.x;
        const posY = topRowY + drawingOffset.y;
        viewBBoxesRef.current.top = { x: posX, y: posY, w: viewWidth, h: viewHeight };
        
        offscreenCtx.fillText("Top View (XZ)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'top', posX, posY, viewWidth, viewHeight, scale);
        drawAutoCirclesInView(offscreenCtx, 'top', centerX, centerY);
        
        const rectD = depth * scale;
        const rectW = width * scale;
        if (dimensions.width && overallDimensionHosts.width === 'top') {
          offscreenCtx.fillText(`W: ${width.toFixed(1)} mm`, centerX - rectW / 2, centerY + rectD / 2 + 20);
        }
        if (dimensions.depth && overallDimensionHosts.depth === 'top') {
          drawVerticalViewLabel(offscreenCtx, `D: ${depth.toFixed(1)} mm`, centerX - rectW / 2 - 20, centerY);
        }
      }

      // Right-Side View
      if (views.sideRight) {
        const posX = rightSideColX + drawingOffset.x;
        const posY = frontRowY + drawingOffset.y;
        viewBBoxesRef.current.sideRight = { x: posX, y: posY, w: viewWidth, h: viewHeight };
        
        offscreenCtx.fillText("Right Side (YZ)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'sideRight', posX, posY, viewWidth, viewHeight, scale);
        drawAutoCirclesInView(offscreenCtx, 'sideRight', centerX, centerY);

        const rectD = depth * scale;
        const rectH = height * scale;
        if (dimensions.depth && overallDimensionHosts.depth === 'sideRight') {
          offscreenCtx.fillText(`D: ${depth.toFixed(1)} mm`, centerX - rectD / 2, centerY + rectH / 2 + 20);
        }
        if (dimensions.height && overallDimensionHosts.height === 'sideRight') {
          drawVerticalViewLabel(offscreenCtx, `H: ${height.toFixed(1)} mm`, centerX + rectD / 2 + 50, centerY);
        }
      }

      // Left-Side View
      if (views.sideLeft) {
        const posX = leftSideColX + drawingOffset.x;
        const posY = frontRowY + drawingOffset.y;
        viewBBoxesRef.current.sideLeft = { x: posX, y: posY, w: viewWidth, h: viewHeight };
        
        offscreenCtx.fillText("Left Side (YZ)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'sideLeft', posX, posY, viewWidth, viewHeight, scale);
        drawAutoCirclesInView(offscreenCtx, 'sideLeft', centerX, centerY);

        const rectD = depth * scale;
        const rectH = height * scale;
        if (dimensions.depth && overallDimensionHosts.depth === 'sideLeft') {
          offscreenCtx.fillText(`D: ${depth.toFixed(1)} mm`, centerX - rectD / 2, centerY + rectH / 2 + 20);
        }
        if (dimensions.height && overallDimensionHosts.height === 'sideLeft') {
          drawVerticalViewLabel(offscreenCtx, `H: ${height.toFixed(1)} mm`, centerX - rectD / 2 - 50, centerY);
        }
      }
    }
    
    // Draw annotations on top of everything (if enabled)
    if (showAnnotations) {
      // Manual annotations resolve their own positions (anchored to view + scale), so
      // they are drawn directly in visual canvas space — no extra offset translate.
      drawAnnotations(offscreenCtx);
    }
    
    // Now draw the offscreen canvas to the main canvas with zoom and pan
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.save();
    ctx.translate(panOffset.x, panOffset.y);
    ctx.scale(zoom, zoom);
    ctx.drawImage(offscreenCanvas, 0, 0);
    
    // Draw temporary points for multi-click tools (on main canvas with zoom/pan applied)
    if (tempPoints.length > 0) {
      ctx.fillStyle = '#00FF00';
      ctx.strokeStyle = '#00FF00';
      ctx.lineWidth = 2;
      tempPoints.forEach((point, idx) => {
        // If this is an auto-detected center, draw special bulls-eye marker
        if (point.autoDetected) {
          ctx.strokeStyle = '#FF6600'; // Orange for auto-detected
          ctx.fillStyle = '#FF6600';
          ctx.lineWidth = 2;
          
          // Draw concentric circles (bulls-eye)
          ctx.beginPath();
          ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(point.x, point.y, 11, 0, Math.PI * 2);
          ctx.stroke();
          
          // Label with "AUTO"
          ctx.font = 'bold 11px Arial';
          ctx.fillText('AUTO', point.x + 15, point.y - 12);
          ctx.fillText('CENTER', point.x + 15, point.y + 2);
        } else {
          // Regular point marker
          ctx.strokeStyle = '#00FF00';
          ctx.fillStyle = '#00FF00';
          ctx.lineWidth = 2;
          
          ctx.beginPath();
          ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
          ctx.fill();
          
          // Draw snap crosshairs
          ctx.beginPath();
          ctx.moveTo(point.x - 10, point.y);
          ctx.lineTo(point.x + 10, point.y);
          ctx.moveTo(point.x, point.y - 10);
          ctx.lineTo(point.x, point.y + 10);
          ctx.stroke();
          
          // Label the point
          ctx.font = 'bold 12px Arial';
          ctx.fillText(`P${idx + 1}`, point.x + 10, point.y - 10);
        }
      });
      
      // For dimension tool: draw preview line and show distance
      if (currentTool === 'dimension' && tempPoints.length === 1 && mouseCanvasPos) {
        ctx.strokeStyle = '#00FF00';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(tempPoints[0].x, tempPoints[0].y);
        ctx.lineTo(mouseCanvasPos.x, mouseCanvasPos.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Show live distance measurement
        const dist = Math.sqrt(
          (mouseCanvasPos.x - tempPoints[0].x) ** 2 + 
          (mouseCanvasPos.y - tempPoints[0].y) ** 2
        );
        const distMM = dist / (currentScaleRef.current || 1);
        const midX = (tempPoints[0].x + mouseCanvasPos.x) / 2;
        const midY = (tempPoints[0].y + mouseCanvasPos.y) / 2;
        
        ctx.fillStyle = '#00FF00';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(`${distMM.toFixed(2)} mm`, midX + 10, midY - 10);
      }
      
      // For radius tool: draw preview circle from center to mouse
      if (currentTool === 'radius' && tempPoints.length === 1 && mouseCanvasPos) {
        const centerX = tempPoints[0].x;
        const centerY = tempPoints[0].y;
        const radius = Math.sqrt(
          (mouseCanvasPos.x - centerX) ** 2 + 
          (mouseCanvasPos.y - centerY) ** 2
        );
        const radiusMM = radius / (currentScaleRef.current || 1);
        
        ctx.strokeStyle = tempPoints[0].autoDetected ? '#FF6600' : '#00FF00';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        
        // Draw preview circle
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();
        
        // Draw radius line
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(mouseCanvasPos.x, mouseCanvasPos.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Show radius measurement
        const midX = (centerX + mouseCanvasPos.x) / 2;
        const midY = (centerY + mouseCanvasPos.y) / 2;
        ctx.fillStyle = tempPoints[0].autoDetected ? '#FF6600' : '#00FF00';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(`R ${radiusMM.toFixed(2)} mm`, midX + 10, midY - 10);
      }
      
      ctx.lineWidth = 1;
    }
    
    // Draw hover snap preview (shows where click will snap to)
    if (hoverSnapPreview && currentTool !== 'none') {
      ctx.strokeStyle = '#00FF00';
      ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
      ctx.lineWidth = 2;
      
      // Outer ring
      ctx.beginPath();
      ctx.arc(hoverSnapPreview.x, hoverSnapPreview.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      
      // Inner crosshair
      ctx.strokeStyle = '#00FF00';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(hoverSnapPreview.x - 12, hoverSnapPreview.y);
      ctx.lineTo(hoverSnapPreview.x + 12, hoverSnapPreview.y);
      ctx.moveTo(hoverSnapPreview.x, hoverSnapPreview.y - 12);
      ctx.lineTo(hoverSnapPreview.x, hoverSnapPreview.y + 12);
      ctx.stroke();
    }
    
    ctx.restore();
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-100">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 py-2 bg-white border-b shadow-sm flex-shrink-0">
        <motion.h1
          className="text-xl font-bold whitespace-nowrap"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          STL to 2D Engineering Drawing
        </motion.h1>
        {fileName && <span className="text-sm text-gray-400 truncate">{fileName}</span>}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: controls only ── */}
        <div className="w-72 flex-shrink-0 bg-white border-r overflow-y-auto">
          <div className="p-4 space-y-5">

            <div>
              <Input type="file" accept=".stl" onChange={handleFileUpload} />

            </div>

            <div className="space-y-2">
              <Input placeholder="Drawing Name" value={drawingName} onChange={(e) => setDrawingName(e.target.value)} />
              <Input placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} />
              <Input placeholder="Your Name" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">Views:</h2>
              <div className="space-y-1">
                {[['front', 'Front View (XY)'], ['top', 'Top View (XZ)'], ['sideRight', 'Right Side View'], ['sideLeft', 'Left Side View']].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={views[key]}
                      onCheckedChange={(val) => {
                        setViews({ ...views, [key]: val });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">Drawing Scale:</h2>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={useManualScale}
                    onCheckedChange={(val) => {
                      setUseManualScale(val);
                      if (geometry) draw2D(geometry);
                    }}
                  />
                  Use Manual Scale
                </label>
                {useManualScale ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      placeholder="Scale"
                      value={manualScale}
                      onChange={(e) => setManualScale(e.target.value)}
                      step="0.1"
                      min="0.01"
                      className="w-20"
                    />
                    <span className="text-xs text-gray-500">:1</span>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">
                    Auto: {drawingScale > 0
                      ? `${drawingScale.toFixed(3)} (${drawingScale > 1 ? `${drawingScale.toFixed(1)}:1` : `1:${(1 / drawingScale).toFixed(1)}`})`
                      : 'Calculating\u2026'}
                  </p>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">Model Rotation:</h2>
              <div className="space-y-2">
                {['x', 'y', 'z'].map((axis) => (
                  <div key={axis} className="flex items-center gap-2">
                    <span className="text-xs font-mono w-4 notranslate" translate="no">{axis.toUpperCase()}</span>
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="1"
                      value={rotation[axis]}
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        if (!isNaN(v)) setRotation({ ...rotation, [axis]: Math.max(-180, Math.min(180, v)) });
                      }}
                      onWheel={(e) => {
                        e.preventDefault();
                        const delta = e.deltaY < 0 ? 1 : -1;
                        setRotation(prev => ({ ...prev, [axis]: Math.max(-180, Math.min(180, prev[axis] + delta)) }));
                      }}
                      className="flex-1 border rounded px-2 py-1 text-xs text-right tabular-nums w-0"
                      style={{ minWidth: 0 }}
                    />
                    <span className="text-xs text-gray-400">&deg;</span>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setRotation({ x: 0, y: 0, z: 0 })}
                  disabled={rotation.x === 0 && rotation.y === 0 && rotation.z === 0}
                >
                  &#8635; Reset Rotation
                </Button>
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">View Controls:</h2>
              <div className="grid grid-cols-3 gap-1 mb-1">
                <Button onClick={handleZoomIn} variant="outline" size="sm">&#128269;+</Button>
                <Button onClick={handleZoomOut} variant="outline" size="sm">&#128269;&minus;</Button>
                <Button onClick={handleZoomReset} variant="outline" size="sm">&#8635;</Button>
              </div>
              <p className="text-xs text-gray-400">Zoom: {Math.round(zoom * 100)}% &middot; scroll or drag</p>
              <Button
                className="w-full mt-1"
                variant="outline"
                size="sm"
                onClick={() => setDrawingOffset({ x: 0, y: 0 })}
              >
                Reset View Positions
              </Button>
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">Dimensions:</h2>
              <div className="space-y-1">
                {[['width', 'Width (X)'], ['height', 'Height (Y)'], ['depth', 'Depth (Z)']].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={dimensions[key]}
                      onCheckedChange={(val) => {
                        setDimensions({ ...dimensions, [key]: val });
                        if (geometry) draw2D(geometry);
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">Annotation Tools:</h2>
              <div className="text-xs text-green-700 mb-2 p-2 bg-green-50 rounded">
                Auto-detection: {detectedCircleCount} radii found
                <div className="text-[11px] text-green-600 mt-1">
                    {detectedCircleBreakdown.fullCircles} full circles &middot; {detectedCircleBreakdown.profileRadii} profile radii &middot; {detectedCircleBreakdown.majorProfileArcs} major arcs
                </div>
              </div>
              <div className="space-y-1 mb-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={autoDetectionFilters.fullCircles}
                    onCheckedChange={(val) => setAutoDetectionFilters(prev => ({ ...prev, fullCircles: !!val }))}
                  />
                  Auto full circles ({detectedCircleBreakdown.fullCircles})
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={autoDetectionFilters.profileRadii}
                    onCheckedChange={(val) => setAutoDetectionFilters(prev => ({ ...prev, profileRadii: !!val }))}
                  />
                  Auto profile radii ({detectedCircleBreakdown.profileRadii})
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={autoDetectionFilters.majorProfileArcs}
                    onCheckedChange={(val) => setAutoDetectionFilters(prev => ({ ...prev, majorProfileArcs: !!val }))}
                  />
                  Auto major profile arcs ({detectedCircleBreakdown.majorProfileArcs})
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={showSideViewDetails}
                    onCheckedChange={(val) => setShowSideViewDetails(!!val)}
                  />
                  Auto side-view details
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={showAutoGaps}
                    onCheckedChange={(val) => setShowAutoGaps(!!val)}
                  />
                  Auto gap dimensions
                </label>
              </div>
              <div className="mb-2 p-2 bg-blue-50 rounded border border-blue-200">
                <div className="text-xs font-semibold text-blue-900 mb-2">Radius Filter (mm)</div>
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-gray-600">Min:</label>
                    <Input
                      type="number"
                      min="0"
                      max={maxRadiusFilter}
                      step="0.5"
                      value={minRadiusFilter}
                      onChange={(e) => setMinRadiusFilter(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Max:</label>
                    <Input
                      type="number"
                      min={minRadiusFilter}
                      step="0.5"
                      value={maxRadiusFilter}
                      onChange={(e) => setMaxRadiusFilter(Math.max(minRadiusFilter, parseFloat(e.target.value) || 20))}
                      className="h-7 text-xs"
                    />
                  </div>
                  <button
                    onClick={() => setHiddenAutoAnnotations(new Set())}
                    className="w-full text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 rounded text-blue-900"
                  >
                    Show All Hidden
                  </button>
                  <div className="text-[10px] text-gray-500 italic">
                    Right-click any annotation to delete/hide it
                  </div>
                </div>
              </div>
              <div className="mb-2">
                <div className="text-xs text-gray-500 mb-1">Profile radii views</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {[
                    ['detected', 'Detected'],
                    ['front', 'Front'],
                    ['top', 'Top'],
                    ['sideRight', 'Right'],
                    ['sideLeft', 'Left'],
                  ].map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={profileRadiiViews[value]}
                        onCheckedChange={(checked) => {
                          const enabled = !!checked;
                          if ((value === 'sideRight' || value === 'sideLeft') && enabled) setShowSideViewDetails(true);
                          setProfileRadiiViews(prev => ({ ...prev, [value]: enabled }));
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <Button
                onClick={() => {
                  if (!geometry) return;
                  const rotGeom = getRotatedGeometry(geometry, rotation);
                  rotGeom.computeBoundingBox();
                  const rBbox = rotGeom.boundingBox;
                  const positions = rotGeom.attributes.position.array;
                  const cx = (rBbox.max.x + rBbox.min.x) / 2;
                  const cy = (rBbox.max.y + rBbox.min.y) / 2;
                  const cz = (rBbox.max.z + rBbox.min.z) / 2;
                  // Always detect in all views — parts may be non-square but still have circular features
                  const front     = detectCircles(positions, 'front',     cx, cy, cz);
                  const top       = detectCircles(positions, 'top',       cx, cy, cz);
                  const sideRight = detectCircles(positions, 'sideRight', cx, cy, cz);
                  const sideLeft  = detectCircles(positions, 'sideLeft',  cx, cy, cz);
                  applyDetectedCircles({ front, top, sideRight, sideLeft });
                  draw2D(geometry);
                }}
                disabled={!geometry}
                variant="outline"
                size="sm"
                className="w-full mb-2 bg-green-50 border-green-600 text-green-700 hover:bg-green-100"
              >
                Re-run Auto-Detection
              </Button>
              <div className="grid grid-cols-2 gap-1 mb-2">
                {[['dimension', 'Dim'], ['radius', 'Radius'], ['angle', 'Angle'], ['text', 'Text']].map(([tool, label]) => (
                  <Button
                    key={tool}
                    onClick={() => setCurrentTool(currentTool === tool ? 'none' : tool)}
                    variant={currentTool === tool ? 'default' : 'outline'}
                    size="sm"
                    className={currentTool === tool ? 'bg-blue-600' : ''}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {currentTool !== 'none' && (
                <div className="text-xs text-blue-600 mb-2 p-2 bg-blue-50 rounded">
                  {currentTool === 'dimension' && 'Click two points to add dimension'}
                  {currentTool === 'radius' && 'Click on an arc — center is found automatically (Shift-click for manual center)'}
                  {currentTool === 'angle' && 'Click near a corner — angle is detected automatically (Shift-click to place 3 points manually)'}
                  {currentTool === 'text' && 'Click to place text annotation'}
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 flex-1 text-sm">
                  <Checkbox checked={showAnnotations} onCheckedChange={(val) => setShowAnnotations(val)} />
                  Show Annotations
                </label>
                {annotations.length > 0 && (
                  <Button
                    onClick={() => {
                      setAnnotations([]);
                      setTempPoints([]);
                      applyDetectedCircles(createEmptyAutoCircles());
                    }}
                    variant="outline"
                    size="sm"
                    className="text-red-600 border-red-600 hover:bg-red-50"
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">Projection:</h2>
              <div className="space-y-1">
                {[['first', 'First Angle — ISO (Europe/UK)'], ['third', 'Third Angle — ASME (USA/Canada)']].map(([type, label]) => (
                  <label key={type} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="projection"
                      checked={projectionType === type}
                      onChange={() => {
                        setProjectionType(type);
                        if (geometry) draw2D(geometry);
                      }}
                      className="w-4 h-4"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <Button className="w-full" onClick={() => geometry && draw2D(geometry)}>
              Update Drawing
            </Button>

            <div className="grid grid-cols-3 gap-1">
              <Button onClick={downloadAsPNG} disabled={!geometry} variant="outline" size="sm">PNG</Button>
              <Button onClick={downloadAsPDF} disabled={!geometry} size="sm" className="bg-red-600 hover:bg-red-700 text-white">PDF</Button>
              <Button onClick={downloadAsSVG} disabled={!geometry} size="sm" className="bg-green-600 hover:bg-green-700 text-white">SVG</Button>
            </div>

          </div>
        </div>

        {/* ── Right: 3D viewer (top) + 2D drawing (bottom) ── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* 3D Preview — canvas is always mounted so the ref is available when geometry loads */}
          <div className="flex-shrink-0 border-b" style={{ height: '42%' }}>
            <div className="flex items-center justify-between px-3 py-1 bg-gray-800 text-white">
              <span className="text-xs font-medium">3D Preview — drag to rotate</span>
              <span className="text-xs text-gray-400 tabular-nums">
                X {rotation.x}° · Y {rotation.y}° · Z {rotation.z}°
              </span>
            </div>
            <div className="relative" style={{ height: 'calc(100% - 24px)' }}>
              {/* Canvas always in DOM so previewCanvasRef is never null on first draw */}
              <canvas
                ref={previewCanvasRef}
                width={900}
                height={500}
                style={{ width: '100%', height: '100%', background: '#1e1e2e', cursor: geometry ? 'grab' : 'default', touchAction: 'none', display: 'block' }}
                onMouseDown={handle3DMouseDown}
                onMouseMove={handle3DMouseMove}
                onMouseUp={handle3DMouseUp}
                onMouseLeave={handle3DMouseUp}
                onTouchStart={handle3DTouchStart}
                onTouchMove={handle3DTouchMove}
                onTouchEnd={handle3DTouchEnd}
              />
              {/* Placeholder overlay shown only before a file is loaded */}
              {!geometry && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-gray-500 text-sm">Load an STL file to see the 3D preview</p>
                </div>
              )}
            </div>
          </div>

          {/* 2D Drawing */}
          <div className="flex-1 overflow-auto bg-gray-300 p-3">
            <canvas
              ref={canvasRef}
              width={1754}
              height={1240}
              className="border shadow-lg mx-auto block"
              style={{
                imageRendering: 'crisp-edges',
                cursor: currentTool !== 'none' ? 'crosshair' : (isPanning || isDraggingView) ? 'grabbing' : 'grab',
                width: '100%',
                height: 'auto',
              }}
              onClick={handleCanvasClick}
              onContextMenu={handleCanvasContextMenu}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleCanvasMouseLeave}
            />
          </div>

        </div>
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-t text-xs text-gray-500 flex-shrink-0">
        <span>
          Developed by{' '}
          <a
            href="https://dafocreative.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            DAFO Creative
          </a>
        </span>
        <div id="donate-button"></div>
      </div>
    </div>
  );
}
