# STL2TechDraw

A web application for converting STL 3D models into professional technical drawings with automatic feature detection, annotations, and multiple export formats.

## Features

- 📂 Upload and parse STL files
- 🎨 Multiple view projections (Front, Top, Side)
- 🔄 First and Third angle projection support
- 📐 Automatic feature detection (circles, holes, dimensions)
- ✏️ Manual annotation tools (dimensions, radius, angles, text)
- 🔍 Zoom and pan controls
- 📏 Manual and auto-scaling options
- 📥 Export to PNG, PDF, and SVG formats
- 📄 Professional A3 title block with drawing information

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
4. **Add Annotations**: 
   - Auto-detection finds circles and holes automatically
   - Use manual tools for dimensions, radius, angles, and text
5. **Navigate**: 
   - Mouse wheel to zoom
   - Left-click drag to pan
   - Reset button to restore view
6. **Export**: Download as PNG, PDF, or SVG

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

## Contributing

Documentation will be loaded on [CheekyFactor.com](https://CheekyFactor.com/index.php/STL2TechDraw), if you would like to contribute, please contact the developer via [DAFO Creative](https://dafocreative.com)