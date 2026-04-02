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

export default function STLToDrawingApp() {
  const [fileName, setFileName] = useState("");
  const [author, setAuthor] = useState("");
  const [company, setCompany] = useState("");
  const [drawingName, setDrawingName] = useState("");
  const [dimensions, setDimensions] = useState({ width: true, height: true, depth: true });
  const [views, setViews] = useState({ front: true, top: false, side: false });
  const [projectionType, setProjectionType] = useState("third"); // "first" or "third"
  const [stlDimensions, setStlDimensions] = useState(null);
  const [drawingDate] = useState(new Date().toLocaleDateString());
  const [geometry, setGeometry] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [currentTool, setCurrentTool] = useState('none'); // 'none', 'radius', 'angle', 'dimension', 'text'
  const [tempPoints, setTempPoints] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPosition, setLastPanPosition] = useState({ x: 0, y: 0 });
  const [drawingScale, setDrawingScale] = useState(1);
  const [useManualScale, setUseManualScale] = useState(false);
  const [manualScale, setManualScale] = useState("1");
  const [rotation, setRotation] = useState({ x: 0, y: 0, z: 0 });
  const canvasRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  // Refs keep 3D drag stateless (no re-renders during move)
  const liveRotationRef = useRef({ x: 0, y: 0, z: 0 });
  const isDragging3DRef = useRef(false);
  const lastDragPos3DRef = useRef({ x: 0, y: 0 });

  // A3 size in pixels at ~140 DPI for good quality (420mm × 297mm)
  const CANVAS_WIDTH = 1754;
  const CANVAS_HEIGHT = 1240;

  // Redraw when annotations, zoom, or pan changes
  useEffect(() => {
    if (geometry && stlDimensions) {
      draw2D(geometry, stlDimensions.width, stlDimensions.height, stlDimensions.depth);
    }
  }, [annotations, tempPoints, zoom, panOffset, showAnnotations, useManualScale, manualScale, rotation]);

  // Recalculate auto-detected features when scale settings change
  useEffect(() => {
    if (geometry && stlDimensions) {
      const rotGeom = getRotatedGeometry(geometry, rotation);
      rotGeom.computeBoundingBox();
      const bbox = rotGeom.boundingBox;
      const rotWidth = bbox.max.x - bbox.min.x;
      const rotHeight = bbox.max.y - bbox.min.y;
      const rotDepth = bbox.max.z - bbox.min.z;
      const detectedAnnotations = detectFeatures(rotGeom, bbox, rotWidth, rotHeight, rotDepth);
      setAnnotations(detectedAnnotations);
    }
  }, [useManualScale, manualScale, views.front, views.top, views.side, rotation]);

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
      setZoom(1);
      setPanOffset({ x: 0, y: 0 });
      
      // Auto-detect features for annotations
      const autoAnnotations = detectFeatures(loadedGeometry, bbox, width, height, depth);
      setAnnotations(autoAnnotations);
      
      draw2D(loadedGeometry, width, height, depth);
    };
    reader.readAsArrayBuffer(file);
  };

  const detectFeatures = (geom, bbox, width, height, depth) => {
    const annotations = [];
    const positions = geom.attributes.position.array;
    
    // Calculate scale for canvas coordinates (matching draw2D logic)
    const canvas = canvasRef.current;
    if (!canvas) return annotations;
    
    const margin = 80;
    const usableWidth = canvas.width - margin * 2;
    const usableHeight = canvas.height - margin * 2 - 200;
    
    const activeViews = Object.values(views).filter(v => v).length || 1;
    const viewSpacing = 40;
    
    let viewWidth, viewHeight;
    if (activeViews === 1) {
      viewWidth = usableWidth;
      viewHeight = usableHeight;
    } else if (activeViews === 2) {
      if (views.front && views.top) {
        viewWidth = usableWidth;
        viewHeight = (usableHeight - viewSpacing) / 2;
      } else {
        viewWidth = (usableWidth - viewSpacing) / 2;
        viewHeight = usableHeight;
      }
    } else {
      viewWidth = (usableWidth - viewSpacing) / 2;
      viewHeight = (usableHeight - viewSpacing) / 2;
    }
    
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
    
    const centerModelX = (bbox.max.x + bbox.min.x) / 2;
    const centerModelY = (bbox.max.y + bbox.min.y) / 2;
    const centerModelZ = (bbox.max.z + bbox.min.z) / 2;
    
    const startX = margin;
    const startY = margin;
    
    // Detect circles/holes in front view (XY plane)
    if (views.front || activeViews === 1) {
      const circles = detectCircles(positions, 'front', centerModelX, centerModelY, centerModelZ, scale, startX + viewWidth / 2, startY + viewHeight / 2);
      circles.forEach(circle => {
        annotations.push({
          type: 'radius',
          centerX: circle.centerX,
          centerY: circle.centerY,
          x: circle.centerX + circle.radius,
          y: circle.centerY,
          value: parseFloat((circle.radius / scale).toFixed(2))
        });
      });
    }
    
    // Add bounding box dimensions as text annotations
    const dimAnnotations = [
      { type: 'text', text: `Overall Size: ${width.toFixed(1)} × ${height.toFixed(1)} × ${depth.toFixed(1)} mm`, x: startX + 10, y: startY - 35 }
    ];
    
    annotations.push(...dimAnnotations);
    
    return annotations;
  };

  const detectCircles = (positions, viewType, centerModelX, centerModelY, centerModelZ, scale, centerViewX, centerViewY) => {
    const circles = [];
    const points = [];
    
    // Project all vertices to 2D
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      
      let canvasX, canvasY;
      
      if (viewType === 'front') {
        canvasX = centerViewX + (x - centerModelX) * scale;
        canvasY = centerViewY - (y - centerModelY) * scale;
      } else if (viewType === 'top') {
        canvasX = centerViewX + (x - centerModelX) * scale;
        canvasY = centerViewY - (z - centerModelZ) * scale;
      } else if (viewType === 'side') {
        canvasX = centerViewX + (z - centerModelZ) * scale;
        canvasY = centerViewY - (y - centerModelY) * scale;
      }
      
      points.push({ x: canvasX, y: canvasY });
    }
    
    // Simple circle detection: find clusters of points at similar distances from potential center points
    // This is a simplified approach - checks if points form circular patterns
    const gridSize = 10;
    const centerCandidates = new Map();
    
    // Sample some points as potential centers
    for (let i = 0; i < Math.min(points.length, 100); i += 10) {
      const center = points[i];
      const distances = [];
      
      for (let j = 0; j < points.length; j += 5) {
        const dist = Math.sqrt(
          Math.pow(points[j].x - center.x, 2) + 
          Math.pow(points[j].y - center.y, 2)
        );
        if (dist > 5 && dist < 100) { // Reasonable radius range
          distances.push(dist);
        }
      }
      
      // Check if distances cluster around a common value (indicating a circle)
      if (distances.length > 20) {
        distances.sort((a, b) => a - b);
        const median = distances[Math.floor(distances.length / 2)];
        const similar = distances.filter(d => Math.abs(d - median) < 3).length;
        
        if (similar > distances.length * 0.4) { // 40% of points at similar distance
          const key = `${Math.round(center.x / gridSize)},${Math.round(center.y / gridSize)}`;
          if (!centerCandidates.has(key)) {
            centerCandidates.set(key, { centerX: center.x, centerY: center.y, radius: median });
          }
        }
      }
    }
    
    return Array.from(centerCandidates.values()).slice(0, 3); // Limit to 3 circles
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

  const handleCanvasClick = (event) => {
    if (currentTool === 'none' || isPanning) return;
    
    const { x, y } = getCanvasCoordinates(event);

    if (currentTool === 'text') {
      const text = prompt('Enter annotation text:');
      if (text) {
        setAnnotations([...annotations, { type: 'text', x, y, text }]);
        setCurrentTool('none');
      }
    } else if (currentTool === 'radius') {
      if (tempPoints.length === 0) {
        // First click - center point
        setTempPoints([{ x, y }]);
      } else {
        // Second click - edge point
        const centerX = tempPoints[0].x;
        const centerY = tempPoints[0].y;
        const radius = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
        const value = prompt('Enter radius value:', radius.toFixed(2));
        if (value) {
          setAnnotations([...annotations, { 
            type: 'radius', 
            centerX, 
            centerY, 
            x, 
            y, 
            value: parseFloat(value) 
          }]);
        }
        setTempPoints([]);
        setCurrentTool('none');
      }
    } else if (currentTool === 'angle') {
      const newPoints = [...tempPoints, { x, y }];
      if (newPoints.length === 3) {
        // Three points selected - calculate angle
        const [p1, vertex, p2] = newPoints;
        const angle1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x);
        const angle2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
        let angleDeg = Math.abs((angle2 - angle1) * 180 / Math.PI);
        if (angleDeg > 180) angleDeg = 360 - angleDeg;
        const value = prompt('Enter angle value:', angleDeg.toFixed(1));
        if (value) {
          setAnnotations([...annotations, { 
            type: 'angle', 
            p1, 
            vertex, 
            p2, 
            value: parseFloat(value) 
          }]);
        }
        setTempPoints([]);
        setCurrentTool('none');
      } else {
        setTempPoints(newPoints);
      }
    } else if (currentTool === 'dimension') {
      if (tempPoints.length === 0) {
        setTempPoints([{ x, y }]);
      } else {
        const [p1] = tempPoints;
        const distance = Math.sqrt((x - p1.x) ** 2 + (y - p1.y) ** 2);
        const value = prompt('Enter dimension value:', distance.toFixed(2));
        if (value) {
          setAnnotations([...annotations, { 
            type: 'dimension', 
            x1: p1.x, 
            y1: p1.y, 
            x2: x, 
            y2: y, 
            value: parseFloat(value) 
          }]);
        }
        setTempPoints([]);
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
    if (event.button === 0 || event.button === 1) { // Left or middle mouse button
      setIsPanning(true);
      setLastPanPosition({ x: event.clientX, y: event.clientY });
      event.preventDefault();
    }
  };

  const handleMouseMove = (event) => {
    if (!isPanning) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const deltaX = (event.clientX - lastPanPosition.x) * scaleX;
    const deltaY = (event.clientY - lastPanPosition.y) * scaleY;
    
    setPanOffset({
      x: panOffset.x + deltaX,
      y: panOffset.y + deltaY
    });
    
    setLastPanPosition({ x: event.clientX, y: event.clientY });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
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

    ctx.font = "16px Arial";
    ctx.fillStyle = "#000000";
    ctx.fillText("Drawing:", tbX + 10, tbY + 23);
    ctx.fillText(drawingName || "-", tbX + 100, tbY + 23);

    ctx.fillText("Company:", tbX + 10, tbY + 59);
    ctx.fillText(company || "-", tbX + 100, tbY + 59);

    ctx.fillText("Drawn By:", tbX + 10, tbY + 95);
    ctx.fillText(author || "-", tbX + 100, tbY + 95);

    ctx.fillText("Date:", tbX + 10, tbY + 131);
    ctx.fillText(drawingDate, tbX + 100, tbY + 131);

    ctx.fillText("Scale:", tbX + 10, tbY + 167);
    ctx.fillText(drawingScale > 1 ? `${drawingScale.toFixed(1)}:1` : `1:${(1/drawingScale).toFixed(1)}`, tbX + 100, tbY + 167);

    // Draw projection symbol in bottom left corner
    drawProjectionSymbol(ctx, margin + 20, canvas.height - margin - 50, projectionType);
    
    // Add label for projection type and A3 sheet size
    ctx.font = "12px Arial";
    ctx.fillText(projectionType === "third" ? "Third Angle" : "First Angle", margin + 20, canvas.height - margin - 55);
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
    // side:  look along +X
    const vx = viewType === 'side' ? 1 : 0;
    const vy = viewType === 'top'  ? 1 : 0;
    const vz = viewType === 'front' ? 1 : 0;

    // Round 3-D coordinates to a fixed precision to merge coincident vertices
    const R = (n) => Math.round(n * 100) / 100;

    // Project a single 3-D point to 2-D canvas coords
    const project = (x, y, z) => {
      if (viewType === 'front') return [centerX + (x - centerModelX) * scale, centerY - (y - centerModelY) * scale];
      if (viewType === 'top')   return [centerX + (x - centerModelX) * scale, centerY - (z - centerModelZ) * scale];
      /* side */                return [centerX + (z - centerModelZ) * scale, centerY - (y - centerModelY) * scale];
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
    annotations.forEach((annotation) => {
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
    
    // Draw temporary points for multi-click tools
    if (tempPoints.length > 0) {
      ctx.fillStyle = '#00FF00';
      tempPoints.forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
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

    const rotatedGeom = getRotatedGeometry(geom, rotation);
    rotatedGeom.computeBoundingBox();
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

    drawBorderAndTitleBlock(offscreenCtx, offscreenCanvas);

    const margin = 80;
    const usableWidth = canvas.width - margin * 2;
    const usableHeight = canvas.height - margin * 2 - 200;

    // Count active views
    const activeViews = Object.values(views).filter(v => v).length;
    if (activeViews === 0) return;

    const viewSpacing = 40;
    let viewWidth, viewHeight;
    
    // Layout: Front view top-left, Top view below front, Side view to right of front
    if (activeViews === 1) {
      viewWidth = usableWidth;
      viewHeight = usableHeight;
    } else if (activeViews === 2) {
      // Two views: arrange based on which ones are active
      if (views.front && views.top) {
        // Front above, top below
        viewWidth = usableWidth;
        viewHeight = (usableHeight - viewSpacing) / 2;
      } else {
        // Side by side
        viewWidth = (usableWidth - viewSpacing) / 2;
        viewHeight = usableHeight;
      }
    } else {
      // Three views: 2x2 grid layout
      viewWidth = (usableWidth - viewSpacing) / 2;
      viewHeight = (usableHeight - viewSpacing) / 2;
    }

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

    offscreenCtx.font = "20px Arial";
    offscreenCtx.fillStyle = "#000000";

    const startX = margin;
    const startY = margin;

    if (rotatedGeom) {
      const bbox = rotatedGeom.boundingBox;

      // Front View - Top Left
      if (views.front) {
        const posX = startX;
        const posY = startY;
        
        offscreenCtx.fillText("Front View (XY)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'front', posX, posY, viewWidth, viewHeight, scale);
        
        // Dimensions for front view
        const rectW = width * scale;
        const rectH = height * scale;
        if (dimensions.width) {
          offscreenCtx.fillText(`W: ${width.toFixed(1)} mm`, centerX - rectW / 2, centerY + rectH / 2 + 20);
        }
        if (dimensions.height) {
          offscreenCtx.save();
          offscreenCtx.translate(centerX - rectW / 2 - 20, centerY);
          offscreenCtx.rotate(-Math.PI / 2);
          offscreenCtx.fillText(`H: ${height.toFixed(1)} mm`, 0, 0);
          offscreenCtx.restore();
        }
      }

      // Top View - Below Front View
      if (views.top) {
        const posX = startX;
        const posY = startY + viewHeight + viewSpacing;
        
        offscreenCtx.fillText("Top View (XZ)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'top', posX, posY, viewWidth, viewHeight, scale);
        
        // Dimensions for top view
        const rectW = width * scale;
        const rectD = depth * scale;
        if (dimensions.width) {
          offscreenCtx.fillText(`W: ${width.toFixed(1)} mm`, centerX - rectW / 2, centerY + rectD / 2 + 20);
        }
        if (dimensions.depth) {
          offscreenCtx.save();
          offscreenCtx.translate(centerX - rectW / 2 - 20, centerY);
          offscreenCtx.rotate(-Math.PI / 2);
          offscreenCtx.fillText(`D: ${depth.toFixed(1)} mm`, 0, 0);
          offscreenCtx.restore();
        }
      }

      // Side View - To the right of Front View
      if (views.side) {
        const posX = startX + viewWidth + viewSpacing;
        const posY = startY;
        
        offscreenCtx.fillText("Side View (YZ)", posX + viewWidth / 2 - 50, posY - 10);
        const { centerX, centerY } = drawProjection(offscreenCtx, rotatedGeom, bbox, 'side', posX, posY, viewWidth, viewHeight, scale);
        
        // Dimensions for side view
        const rectD = depth * scale;
        const rectH = height * scale;
        if (dimensions.depth) {
          offscreenCtx.fillText(`D: ${depth.toFixed(1)} mm`, centerX - rectD / 2, centerY + rectH / 2 + 20);
        }
        if (dimensions.height) {
          offscreenCtx.save();
          offscreenCtx.translate(centerX - rectD / 2 - 20, centerY);
          offscreenCtx.rotate(-Math.PI / 2);
          offscreenCtx.fillText(`H: ${height.toFixed(1)} mm`, 0, 0);
          offscreenCtx.restore();
        }
      }
    }
    
    // Draw annotations on top of everything (if enabled)
    if (showAnnotations) {
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
              <p className="text-sm font-semibold mb-2">Views:</p>
              <div className="space-y-1">
                {[['front', 'Front View (XY)'], ['top', 'Top View (XZ)'], ['side', 'Side View (YZ)']].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={views[key]}
                      onCheckedChange={(val) => {
                        setViews({ ...views, [key]: val });
                        if (geometry) draw2D(geometry);
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold mb-2">Dimensions:</p>
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
              <p className="text-sm font-semibold mb-2">Drawing Scale:</p>
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
              <p className="text-sm font-semibold mb-2">Model Rotation:</p>
              <div className="space-y-2">
                {['x', 'y', 'z'].map((axis) => (
                  <div key={axis} className="flex items-center gap-2">
                    <span className="text-xs font-mono w-4">{axis.toUpperCase()}</span>
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      value={rotation[axis]}
                      onChange={(e) => setRotation({ ...rotation, [axis]: parseInt(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-xs w-10 text-right tabular-nums">{rotation[axis]}&deg;</span>
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
              <p className="text-sm font-semibold mb-2">View Controls:</p>
              <div className="grid grid-cols-3 gap-1 mb-1">
                <Button onClick={handleZoomIn} variant="outline" size="sm">&#128269;+</Button>
                <Button onClick={handleZoomOut} variant="outline" size="sm">&#128269;&minus;</Button>
                <Button onClick={handleZoomReset} variant="outline" size="sm">&#8635;</Button>
              </div>
              <p className="text-xs text-gray-400">Zoom: {Math.round(zoom * 100)}% &middot; scroll or drag</p>
            </div>

            <div>
              <p className="text-sm font-semibold mb-2">Annotation Tools:</p>
              <div className="text-xs text-green-700 mb-2 p-2 bg-green-50 rounded">
                Auto-detection: {annotations.filter(a => a.type === 'radius').length} circles found
              </div>
              <Button
                onClick={() => {
                  if (geometry) {
                    const rotGeom = getRotatedGeometry(geometry, rotation);
                    rotGeom.computeBoundingBox();
                    const rBbox = rotGeom.boundingBox;
                    const autoAnnotations = detectFeatures(rotGeom, rBbox,
                      rBbox.max.x - rBbox.min.x, rBbox.max.y - rBbox.min.y, rBbox.max.z - rBbox.min.z);
                    setAnnotations(autoAnnotations);
                  }
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
                  {currentTool === 'radius' && 'Click center, then edge point'}
                  {currentTool === 'angle' && 'Click 3 points: first, vertex, second'}
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
                      if (geometry) draw2D(geometry);
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
              <p className="text-sm font-semibold mb-2">Projection:</p>
              <div className="space-y-1">
                {[['third', 'Third-Angle (US/ISO)'], ['first', 'First-Angle (European)']].map(([type, label]) => (
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
                cursor: currentTool !== 'none' ? 'crosshair' : isPanning ? 'grabbing' : 'grab',
                width: '100%',
                height: 'auto',
              }}
              onClick={handleCanvasClick}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            />
          </div>

        </div>
      </div>
    </div>
  );
}
