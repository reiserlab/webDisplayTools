// Test if pat-parser.js loads correctly in Node.js environment
console.log('=== PatParser Node.js Test ===\n');

try {
    // Load the file
    const PatParser = require('./js/pat-parser.js');

    console.log('✓ pat-parser.js loaded successfully');
    console.log('✓ PatParser type:', typeof PatParser);
    console.log('✓ PatParser is:', PatParser.constructor.name);

    // Check methods
    const methods = Object.keys(PatParser);
    console.log('\nAvailable methods/properties:');
    methods.forEach((m) => {
        console.log(`  - ${m}: ${typeof PatParser[m]}`);
    });

    // Test parse method
    if (typeof PatParser.parse === 'function') {
        console.log('\n✓ PatParser.parse() exists and is a function');
    } else {
        console.log('\n✗ PatParser.parse() NOT FOUND');
    }

    // Test detectGeneration
    if (typeof PatParser.detectGeneration === 'function') {
        console.log('✓ PatParser.detectGeneration() exists and is a function');

        // Create a test G6 header
        const headerBytes = Buffer.from([
            0x47,
            0x36,
            0x50,
            0x54, // 'G6PT' magic
            0x14,
            0x00, // 20x20 panels
            0x00,
            0x00,
            0x00,
            0x01, // 1 frame
            0x00,
            0x00,
            0x00,
            0x00, // row index start
            0x01, // GS2
            0x00,
            0x00 // padding
        ]);

        try {
            const gen = PatParser.detectGeneration(headerBytes.buffer);
            console.log(`✓ detectGeneration test: Detected "${gen}" (expected "G6")`);
        } catch (error) {
            console.log('✗ detectGeneration test failed:', error.message);
        }
    } else {
        console.log('✗ PatParser.detectGeneration() NOT FOUND');
    }

    console.log('\n=== All tests passed! ===');
    console.log('PatParser loads correctly in Node.js');
    console.log('\nIf GitHub Pages still shows "PatParser is not defined":');
    console.log('1. Check browser console for JavaScript errors');
    console.log('2. Verify js/pat-parser.js is being served (check Network tab)');
    console.log('3. Try hard refresh (Ctrl+Shift+R)');
    console.log('4. Check if Content Security Policy is blocking the script');
} catch (error) {
    console.error('\n✗ FAILED TO LOAD pat-parser.js');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
}
