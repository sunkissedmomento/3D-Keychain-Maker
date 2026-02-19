from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import subprocess
from pathlib import Path
import tempfile
import re
from io import BytesIO
import os

app = Flask(__name__)
CORS(app)

# =========================
# OpenSCAD executable
# =========================
OPENSCAD_PATH = r"C:\Program Files\OpenSCAD\openscad.exe"

# =========================
# Fonts directory
# =========================
FONTS_DIR = Path(__file__).parent / "fonts"

# Only fonts inside the fonts/ folder
FONT_MAP = {
    'Pacifico:style=Regular': 'Pacifico-Regular.ttf',
    'Lobster:style=Regular': 'Lobster-Regular.ttf'
}

# =========================
# Helpers
# =========================
def sanitize_name(name):
    """Remove unwanted characters and limit length"""
    return re.sub(r'[^a-zA-Z0-9 _-]', '', name)[:20]

def calculate_hole_offset(name, width_option, border_thickness):
    """
    Calculate hole tab offset with smooth auto-adjustment
    
    The offset automatically scales with text length:
    - Short names get tighter spacing
    - Long names get progressively more spacing
    - No sudden jumps or categories
    """
    name_len = len(name)
    
    # Constant multiplier for text width
    multiplier = 0.57
    
    # Border factor increases smoothly with length
    # Starts at 2.0 for short names, increases by 0.1 per character
    border_factor = 2.0 + (name_len - 2) * 0.1
    
    offset = name_len * width_option * multiplier / 2 + border_thickness * border_factor
    
    return offset

# =========================
# Routes
# =========================
@app.route('/generate-stl', methods=['POST'])
def generate_stl():
    try:
        data = request.json
        name = sanitize_name(data.get('name', 'Keychain'))
        font_key = data.get('font', 'Pacifico:style=Regular')
        text_height = float(data.get('textHeight', 3.0))
        border_thickness = float(data.get('borderThickness', 2))
        width_option = float(data.get('widthOption', 15))

        print(f"\n=== Generating STL: name='{name}', font='{font_key}' ===")

        # ===== Load font from fonts/ folder only =====
        font_file = FONT_MAP.get(font_key)
        if not font_file:
            return jsonify({'error': f'Font "{font_key}" is not available'}), 400

        font_path = FONTS_DIR / font_file
        if not font_path.exists():
            return jsonify({'error': f'Font file "{font_file}" not found in fonts directory'}), 500

        # Use font filename only (OpenSCAD will find it in fonts folder)
        font_spec = font_file

        # Calculate offset with auto-adjustment
        offset = calculate_hole_offset(name, width_option, border_thickness)

        # ===== Generate SCAD code =====
        scad_code = f"""
$fn=12;  // Fast rendering

module text_part() {{
    linear_extrude(height={border_thickness})
        offset(delta={border_thickness})
        text("{name}", size={width_option}, font="{font_spec}", halign="center", valign="center");
    translate([0,0,{border_thickness}])
        linear_extrude(height={text_height})
            text("{name}", size={width_option}, font="{font_spec}", halign="center", valign="center");
}}

module hole_tab() {{
    difference() {{
        cylinder(h={border_thickness}, d=8);
        translate([0,0,-0.1])
            cylinder(h={border_thickness+0.2}, d=4);
    }}
}}

union() {{
    text_part();
    translate([{-offset}, 0, 0])
        hole_tab();
}}
"""

        # ===== Temporary files =====
        with tempfile.TemporaryDirectory() as tmpdir:
            scad_file = Path(tmpdir) / "keychain.scad"
            stl_file = Path(tmpdir) / "keychain.stl"
            scad_file.write_text(scad_code)

            # ===== Run OpenSCAD =====
            openscad_cmd = [
                OPENSCAD_PATH,
                "-o", str(stl_file),
                str(scad_file),
                "--export-format", "binstl",
                "--quiet"
            ]
            
            result = subprocess.run(
                openscad_cmd,
                capture_output=True, 
                text=True
            )

            # Better error logging
            if result.returncode != 0:
                error_msg = result.stderr if result.stderr else result.stdout
                print(f"  OpenSCAD failed:")
                print(f"    Return code: {result.returncode}")
                print(f"    Error: {error_msg}")
                return jsonify({'error': 'OpenSCAD failed', 'details': error_msg or 'Unknown error'}), 500

            if not stl_file.exists():
                print(f"  STL file not created")
                return jsonify({'error': 'STL file not generated'}), 500

            # ===== Send STL =====
            stl_data = stl_file.read_bytes()
            
            print(f"  Success! (len={len(name)}, offset={offset:.2f})")
            
            return send_file(
                BytesIO(stl_data),
                as_attachment=True,
                download_name=f"{name}_{font_key.split(':')[0]}.stl",
                mimetype='application/sla'
            )

    except Exception as e:
        print(f"Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    return jsonify({'status':'ok'})

# =========================
# Run server
# =========================
if __name__ == "__main__":
    app.run(debug=True, port=5000)