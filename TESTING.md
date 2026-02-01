# Icon Generator Testing Checklist

## Original Issues Reported (must all be fixed)

1. **PatParser error** - "PatParser is not defined" when loading .pat files
2. **Sine pattern** - Shows flat intermediate green instead of varying brightness
3. **Grating pattern** - Looks like "all on" (solid green) instead of stripes
4. **Partial arena** - Two problems:
   - Skipped panels are filled in (should match background color)
   - Not R/L symmetric (gap should be at bottom, centered)

## How to Test

1. Open http://localhost:8080/test_generate_icons.html (or on GitHub Pages)
2. The page will automatically generate 5 test icons
3. Download each PNG and verify the results match expectations below
4. Test pattern loading in main icon_generator.html page (should not error)

## Test Cases

### Test 1: All-On (Full Arena)
**Expected:** Solid green ring (donut shape)
- Uniform LED green color (#00e676)
- Thick outer outline, thin inner outline
- No gaps or variations
- Dark background

### Test 2: Grating Pattern
**Expected:** 10 vertical stripes alternating dark/bright
- Clear alternating pattern (20 pixels on/off)
- Stripes should be visible and distinct
- **CRITICAL**: NOT solid green (that was the bug!)
- Each stripe ~36° wide (360°/10 stripes)
- **If this shows solid green, arc rendering is still broken**

### Test 3: Sine Pattern
**Expected:** Smooth brightness gradient around the ring
- Varies from dark (almost black) to bright (full green) smoothly
- ~3 complete cycles around the arena (60px wavelength)
- **CRITICAL**: NOT flat medium green (that was the bug!)
- Should see clear brightness variation from 0 to 15 (GS16)
- **If this shows uniform medium green, GS16 value range is still wrong**

### Test 4: Partial Arena (White Background)
**Expected:** Gap with radial lines ONLY at boundaries, NO green in gap area
- Green appears on ~252° (7 of 10 columns)
- Gap of ~108° (3 missing columns: 0,1,2)
- **CRITICAL**: Only 2 radial lines at gap boundaries (start and end), NOT multiple lines throughout
- **CRITICAL**: WHITE background visible in gap area (NOT green!)
- **If gap is filled with green, columns_installed is not being respected**
- Gap orientation: Centered at bottom for R/L symmetry

### Test 5: Partial Arena (Dark Background)
**Expected:** Same as Test 4 but with dark background
- Dark background visible in gap area
- Only 2 radial lines at gap boundaries (start/end)

## Bugs That Were Fixed

1. **Sine Pattern** - Was using 0-1 values instead of 0-15 for GS16 mode
   - Resulted in flat medium green
   - Fixed: Now generates proper 0-15 range

2. **Arc Rendering** - Canvas arc() drew wrong direction for CW column order
   - When endAngle < startAngle, arc drew the long way around
   - Resulted in solid colors instead of patterns
   - Fixed: Use Math.min/max to always draw shorter arc

3. **PatParser** - Would error on GitHub Pages if script didn't load
   - Now shows clear error message

## Arena Orientation Notes

Current column mapping (column_order='cw'):
- Column 0 starts at south (-90°)
- Columns increase counter-clockwise (angles decrease)
- For partial arena test: columns 0 and 9 are missing

Expected orientation for partial arenas:
- Gap should appear at bottom (south) for R/L symmetry
- Currently gap appears bottom-right
- May need further adjustment to column_order or angle_offset

## Validation Summary

### Must Pass (Critical Bugs):
- [ ] Test 2 (Grating): Shows 10 distinct stripes, NOT solid green
- [ ] Test 3 (Sine): Shows smooth gradient from dark to bright, NOT flat medium green
- [ ] Test 4 & 5 (Partial): Gap area shows background color (white/dark), NOT filled with green

### Should Work (Enhancement):
- [ ] PatParser loads without error (test by loading .pat file in main page)
- [ ] Partial arena gap is R/L symmetric at bottom (may need orientation adjustment)

### Visual Checklist for Each Icon:
1. **All-On**: ✓ Solid uniform green ring
2. **Grating**: ✓ Clear alternating dark/bright stripes (10 total)
3. **Sine**: ✓ Smooth brightness variation (dark→bright→dark, 3 cycles)
4. **Partial (white)**: ✓ Gap shows WHITE background, radial lines visible
5. **Partial (dark)**: ✓ Gap shows DARK background, radial lines visible

## Next Steps

If all critical tests pass:
- ✓ Merge PR
- Document orientation behavior for partial arenas
- Consider adding angle_offset control for gap positioning

If critical tests fail:
- Check browser console for JavaScript errors
- Verify icon-generator.js loaded correctly
- Test with different browsers
- Provide screenshots of failing tests for debugging
