#import <Cocoa/Cocoa.h>

#include <algorithm>
#include <cmath>

namespace {

NSImage *renderDockImage(bool indeterminate, double progress) {
    constexpr CGFloat canvas = 128.0;
    constexpr CGFloat margin = 9.0;
    constexpr CGFloat barHeight = 12.0;

    NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(canvas, canvas)];
    [image lockFocus];

    NSImage *appIcon = [NSApp applicationIconImage];
    if (appIcon != nil) {
        [appIcon drawInRect:NSMakeRect(0.0, 0.0, canvas, canvas)
                   fromRect:NSZeroRect
                  operation:NSCompositingOperationSourceOver
                   fraction:1.0
             respectFlipped:YES
                      hints:nil];
    }

    const NSRect trackRect = NSMakeRect(
        margin,
        margin,
        canvas - margin * 2.0,
        barHeight
    );
    NSBezierPath *track = [NSBezierPath bezierPathWithRoundedRect:trackRect
                                                         xRadius:barHeight / 2.0
                                                         yRadius:barHeight / 2.0];
    [[NSColor colorWithWhite:0.08 alpha:0.82] setFill];
    [track fill];

    NSRect fillRect = trackRect;
    if (indeterminate) {
        const double phase = std::fmod(
            [NSDate timeIntervalSinceReferenceDate] * 0.9,
            1.0
        );
        fillRect.size.width = trackRect.size.width * 0.34;
        fillRect.origin.x = trackRect.origin.x
            + (trackRect.size.width - fillRect.size.width) * phase;
    } else {
        const double bounded = std::clamp(progress, 0.0, 1.0);
        fillRect.size.width = trackRect.size.width * bounded;
    }

    if (fillRect.size.width > 0.5) {
        NSBezierPath *fill = [NSBezierPath bezierPathWithRoundedRect:fillRect
                                                            xRadius:barHeight / 2.0
                                                            yRadius:barHeight / 2.0];
        [[NSColor controlAccentColor] setFill];
        [fill fill];
    }

    [image unlockFocus];
    return image;
}

} // namespace

extern "C" void novaSetMacDockProgress(
    bool visible,
    bool indeterminate,
    double progress,
    int activeCount
) {
    if (NSApp == nil) {
        return;
    }

    NSDockTile *dockTile = [NSApp dockTile];
    if (dockTile == nil) {
        return;
    }

    if (!visible) {
        [dockTile setBadgeLabel:nil];
        [dockTile setContentView:nil];
        [dockTile display];
        return;
    }

    NSImageView *imageView = [[NSImageView alloc] initWithFrame:NSMakeRect(0.0, 0.0, 128.0, 128.0)];
    [imageView setImageScaling:NSImageScaleAxesIndependently];
    [imageView setImage:renderDockImage(indeterminate, progress)];

    [dockTile setContentView:imageView];
    [dockTile setBadgeLabel:activeCount > 0
        ? [NSString stringWithFormat:@"%d", activeCount]
        : nil];
    [dockTile display];
}
