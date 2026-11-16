package com.pdfgateway;

import java.io.File;
import java.io.IOException;
import org.apache.fontbox.FontBoxFont;
import org.apache.fontbox.ttf.TrueTypeCollection;
import org.apache.fontbox.ttf.TrueTypeFont;
import org.apache.pdfbox.pdmodel.font.CIDFontMapping;
import org.apache.pdfbox.pdmodel.font.FontMapper;
import org.apache.pdfbox.pdmodel.font.FontMappers;
import org.apache.pdfbox.pdmodel.font.FontMapping;
import org.apache.pdfbox.pdmodel.font.PDCIDSystemInfo;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;

/**
 * Lets PDFBox find the CJK font by name wherever CJK_FONT_PATH puts it.
 *
 * <p>PDFBox looks fonts up by name only in ~/.fonts and the system font
 * folders. The CJK font we embed can live elsewhere (the desktop app bundles
 * it). When PDFBox needs that font again before it is embedded, e.g. to draw a
 * filled form field with the not-yet-written subset, the lookup would miss and
 * fall back to a font without Chinese glyphs ("No glyph for U+5F20"). This
 * mapper answers lookups for that one font with the file itself and leaves
 * every other lookup to PDFBox's own mapper.
 */
final class CjkFontMapper implements FontMapper {
    private final FontMapper fallback;
    private final TrueTypeFont font;
    private final String name;

    private CjkFontMapper(FontMapper fallback, TrueTypeFont font) throws IOException {
        this.fallback = fallback;
        this.font = font;
        this.name = font.getName();
    }

    /** Install the mapper for the font at {@code path}; without the font, keep PDFBox's default. */
    static void install(String path) {
        File file = new File(path);
        if (!file.isFile()) {
            return;
        }
        try {
            TrueTypeFont ttf;
            if (path.toLowerCase().endsWith(".ttc")) {
                // Kept open for the life of the process: the font reads from it.
                TrueTypeCollection collection = new TrueTypeCollection(file);
                TrueTypeFont[] first = new TrueTypeFont[1];
                collection.processAllFonts(f -> {
                    if (first[0] == null) {
                        first[0] = f; // the same face FontResources embeds
                    }
                });
                ttf = first[0];
            } else {
                ttf = new org.apache.fontbox.ttf.TTFParser().parse(
                        new org.apache.pdfbox.io.RandomAccessReadBufferedFile(file));
            }
            if (ttf != null) {
                FontMappers.set(new CjkFontMapper(FontMappers.instance(), ttf));
            }
        } catch (IOException exc) {
            System.err.println("CJK font mapping not installed: " + exc.getMessage());
        }
    }

    /** "ABCDEF+WenQuanYiMicroHei" (subset prefix) or "WenQuanYiMicroHei". */
    private boolean isOurs(String baseFont) {
        if (baseFont == null) {
            return false;
        }
        int plus = baseFont.indexOf('+');
        String bare = plus == 6 ? baseFont.substring(plus + 1) : baseFont;
        return bare.equalsIgnoreCase(name);
    }

    @Override
    public FontMapping<TrueTypeFont> getTrueTypeFont(String baseFont, PDFontDescriptor descriptor) {
        return isOurs(baseFont) ? new FontMapping<>(font, false) : fallback.getTrueTypeFont(baseFont, descriptor);
    }

    @Override
    public FontMapping<FontBoxFont> getFontBoxFont(String baseFont, PDFontDescriptor descriptor) {
        return isOurs(baseFont) ? new FontMapping<>(font, false) : fallback.getFontBoxFont(baseFont, descriptor);
    }

    @Override
    public CIDFontMapping getCIDFont(String baseFont, PDFontDescriptor descriptor, PDCIDSystemInfo cidSystemInfo) {
        return isOurs(baseFont)
                ? new CIDFontMapping(null, font, false)
                : fallback.getCIDFont(baseFont, descriptor, cidSystemInfo);
    }
}
