# STL2TechDraw

A web application for converting STL 3D models into professional technical drawings with automatic feature detection, annotations, and multiple export formats.

## Features

- 📂 Upload and parse STL files
- 🎨 Multiple view projections (Front, Top, Right Side, Left Side)
- 🔄 First Angle — ISO (Europe/UK) and Third Angle — ASME (USA/Canada) projection support
- 📐 **Advanced automatic feature detection**:
  - Circles, holes, and arcs of all sizes (small fillets to large radii)
  - Adaptive sector requirements for sparse meshes
  - Intelligent filtering to reduce drawing clutter
- ✏️ **Enhanced manual annotation tools**:
  - Dimensions with snap-to-edge (16px threshold, works at any angle)
  - Radius measurements with center point and edge snapping
  - Angle measurements between any two lines
  - Text labels at any position
  - Live preview while placing annotations
  - Hover preview shows snap point before clicking
- 🎯 **Interactive annotation management**:
  - Right-click any annotation to delete it (manual or auto-detected)
  - Radius range filtering (min/max sliders in mm)
  - Toggle visibility of auto-detected annotation types
  - "Show All Hidden" button to restore deleted annotations
- 🔍 Zoom and pan controls with mouse wheel and drag
- 🖱️ Draggable drawing canvas with per-view positioning
- 📏 Manual and auto-scaling options
- 📥 Export to PNG, PDF, and SVG formats
- 📄 Professional A3 title block with drawing information and projection symbol

## Prerequisites

Before installing, ensure you have the following installed on your system:

- **Node.js** (v18.0.0 or higher) - [Download](https://nodejs.org/)
- **npm** (v9.0.0 or higher) - Comes with Node.js

To verify your installation:
```bash
node --version
npm --version
```

## Dependencies

### Production Dependencies

- **react** (^19.2.0) - UI framework
- **react-dom** (^19.2.0) - React DOM rendering
- **three** (^0.183.1) - 3D graphics library for STL parsing
- **framer-motion** (^12.34.3) - Animation library
- **jspdf** (^4.2.0) - PDF generation library

### Development Dependencies

- **vite** (^7.3.1) - Build tool and dev server
- **@vitejs/plugin-react** (^5.1.1) - Vite React plugin
- **eslint** (^9.39.1) - Code linting
- **eslint-plugin-react-hooks** (^7.0.1) - React hooks linting
- **eslint-plugin-react-refresh** (^0.4.24) - React refresh linting
- **@types/react** (^19.2.7) - React TypeScript types
- **@types/react-dom** (^19.2.3) - React DOM TypeScript types
- **@eslint/js** (^9.39.1) - ESLint JavaScript support
- **globals** (^16.5.0) - Global variables for ESLint

## Installation

### Option 1: Quick Start (Using start.sh)

1. Clone or download the repository
2. Navigate to the project directory:
   ```bash
   cd stl2techdraw
   ```
3. Run the startup script:
   ```bash
   ./start.sh
   ```

The script will:
- Check for Node.js and npm
- Install dependencies if needed
- Start the development server

### Option 2: Manual Installation

1. Clone or download the repository:
   ```bash
   git clone <repository-url>
   cd stl2techdraw
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to:
   ```
   http://localhost:5173
   ```

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run ESLint to check code quality

## Usage

1. **Upload STL File**: Click "Choose File" to upload your STL 3D model
2. **Configure Drawing**: 
   - Enter drawing name, author, and company details
   - Select desired views (Front, Top, Side)
   - Choose projection type (First or Third Angle)
   - Toggle dimensions display
3. **Adjust Scale**: Use auto-scale or set manual scale ratio
4. **Manage Auto-Detection**:
   - Toggle annotation types (full circles, profile radii, major arcs)
   - Adjust radius filter range (Min/Max in mm) to reduce clutter
   - Right-click any auto-detected annotation to hide it
   - Use "Show All Hidden" button to restore hidden annotations
5. **Add Manual Annotations**: 
   - Select tool (Dimension, Radius, Angle, or Text)
   - Green crosshairs show snap preview before clicking
   - Click points to place annotation
   - Dimension tool: Click two points, shows live distance preview
   - Radius tool: Click center, then edge point
   - Angle tool: Click vertex, then two points on the angle arms
   - Text tool: Click position, enter text in prompt
6. **Delete Annotations**:
   - Right-click any annotation (manual or auto) to delete/hide it
   - Manual annotations are permanently removed
   - Auto annotations can be restored with "Show All Hidden"
7. **Navigate**: 
   - Mouse wheel to zoom
   - Left-click drag to pan canvas
   - Click and drag any view to reposition drawings
   - Reset button to restore default view
8. **Export**: Download as PNG, PDF, or SVG

### Tips
- **Reduce clutter**: Adjust the radius filter min/max to show only relevant features
- **Better accuracy**: Use manual tools with snap for precise measurements
- **Clean drawings**: Right-click unwanted annotations to remove them
- **Large models**: Auto-detection works best on meshes with consistent triangle density

## Project Structure

```
stl2techdraw/
├── public/              # Static assets
├── src/
│   ├── components/      # React components
│   │   └── ui/         # UI components (button, card, input, checkbox)
│   ├── assets/         # Images and other assets
│   ├── App.jsx         # Main application component
│   ├── App.css         # Application styles
│   ├── index.css       # Global styles
│   └── main.jsx        # Application entry point
├── index.html          # HTML template
├── package.json        # Project dependencies and scripts
├── vite.config.js      # Vite configuration
├── eslint.config.js    # ESLint configuration
├── start.sh            # Startup script
└── README.md           # This file
```

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

Modern browsers with ES6+ support required.

## Troubleshooting

### Dependencies not installing
```bash
rm -rf node_modules package-lock.json
npm install
```

### Port 5173 already in use
Edit `vite.config.js` to change the port:
```javascript
export default defineConfig({
  server: {
    port: 3000  // Change to your preferred port
  }
})
```

### White screen after changes
- Clear browser cache and hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
- Check browser console for errors
- Restart development server

## License

AGPL-3.0-or-later

## Changelog

### v0.1.3 (Latest)
- **Improved large radius detection** — Lowered sector requirements for large arcs: R>15mm needs only 5 sectors (31%), R>8mm needs 6 sectors (37.5%). Reduced minimum face requirements from 8→6, increased max gap tolerance to 270°, enabling detection of larger features with sparser meshes.
- **Adaptive circle classification** — Circle type determination now adapts based on radius size, correctly classifying very large arcs (R>15mm) as major profile arcs even with fewer sectors.
- **Right-click to delete any annotation** — Right-click anywhere near an annotation to delete it instantly. Works for all annotation types: manual dimensions, radius, angle, text, and auto-detected features. Manual annotations are permanently removed; auto annotations can be restored.
- **Radius range filtering** — New Min/Max radius filter controls (in mm) with numeric inputs. Filter auto-detected annotations by size to reduce drawing clutter while keeping important features visible.
- **Interactive annotation hiding** — Click "Show All Hidden" button to restore all right-click deleted auto annotations at once.
- **Enhanced manual annotation tools** — All manual tools now feature:
  - Snap-to-edge functionality (16px threshold, works at any angle)
  - Green crosshair hover preview shows exact snap point before clicking
  - Live dimension preview line with distance measurement during placement
  - Clear visual feedback with point labels (P1, P2) and tool hints
- **Improved snap visualization** — Temp annotation points now render correctly in all browsers with proper coordinate transforms.
- **Better user control** — UI hint updated to "Right-click any annotation to delete/hide it" to clarify functionality works on all annotation types.
- **Reduced leader line distances** — All radius annotation leader lines shortened: full circles (+18/+30/+42px), major arcs (+6 base with ±10/20 offsets), profile radii (20-50px radial).
- **Auto gap dimensions toggle** — Added checkbox (defaults OFF) to show/hide automatic gap measurements on C-shaped features.

### v0.1.2
- **Circle detection reliability improved** — Removed the old aspect-ratio gating, added edge-bin histogram peak detection, and tuned clustering so circular holes and cylindrical features are detected more consistently across orientations.
- **Better view-specific annotation placement** — Full circles stay on the view where they appear end-on, while profile radii can now be routed to a preferred host view when that makes the drawing clearer.
- **Separate auto-detection toggles** — Auto-detected `full circles` and `profile radii` can now be shown or hidden independently.
- **Cleaner auto-label layout** — Radius callouts now use collision-aware placement and reduced duplicate profile labels to avoid overlapping text and leader lines.
- **Title block text auto-fit** — Value fields (Drawing, Company, Drawn By, etc.) now automatically shrink the font size to fit within the cell boundary, preventing text overflow regardless of input length.
- **Added donation link** - Added a donation link to README.md and the generated webpage.[![Donate with PayPal](https://www.paypalobjects.com/en_US/GB/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/donate/?hosted_button_id=6SM9F5FPT7K4S)
- **Add FUNDING.md** - added a FUNDING.md file.
- **Rotation label translation fix** — Axis labels (X/Y/Z) in the rotation inputs are now marked `translate="no"` to prevent browser auto-translation rendering them as "AND"/"WITH".
- **Side view circle annotations removed** — Circle radius annotations are no longer drawn on side views where the profile is rectangular, eliminating misleading annotations.
- **Aspect ratio filter for circle detection** — Circle detection now only runs for views where the projected bounding box aspect ratio is ≤ 1.4 (roughly circular profile). Rectangular profiles are skipped regardless of STL orientation on load.
- **Kasa algebraic circle fitting** — Replaced the arithmetic mean center with Kasa least-squares circle fitting. The arithmetic mean is biased for partial arcs (e.g. 270° C-clips); Kasa finds the true geometric centre regardless of arc completeness.
- **Inner + outer radius detection** — Detection now finds both the inner and outer cylindrical walls of a ring as separate radius annotations, using 150 histogram bins for fine resolution.
- **Chamfer / bevel detection** — Faces with normals at 30–75° to the view axis (chamfers and bevels) are now included in the radius histogram so chamfered edges appear as additional annotated radii.
- **Spurious peak filtering** — Histogram peak threshold raised to 2.5× the average bin count; real cylindrical surfaces produce peaks 20–100× above average while rectangular noise only reaches 1.5–2×.


### v0.1.1
- **Right Side & Left Side Views** — Added independent checkboxes to enable a Right Side View (looking from −X) and a Left Side View (looking from +X), in addition to the existing Front and Top views.
- **Auto-fit layout** — The drawing area now automatically calculates column and row counts from the active views (up to 3 columns when both side views are enabled) so all views always fit within the page border without overlap.
- **Correct projection placement** — First Angle (ISO): right-side sits left of front, left-side sits right of front. Third Angle (ASME): right-side sits right of front, left-side sits left of front.
- **Draggable views** — All views move together as a single drawing via a unified offset, keeping relative positions consistent.
- **Projection standard labels** — Title block and UI updated to show "First Angle (ISO)" and "Third Angle (ASME)" with regional sub-labels (Europe/UK and USA/Canada).
- **Rotation inputs** — Model rotation fields support mouse-wheel scrolling in addition to typing.
- **Body margin** — Added 10 px page margin for a less cramped layout.

## Contributing

Documentation will be loaded on [CheekyFactor.com](https://CheekyFactor.com/index.php/STL2TechDraw), if you would like to contribute, please contact the developer via [DAFO Creative](https://dafocreative.com)

## Donate

[![Donate with PayPal](https://www.paypalobjects.com/en_US/GB/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/donate/?hosted_button_id=6SM9F5FPT7K4S)
