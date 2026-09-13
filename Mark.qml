import QtQuick
import QtQuick.Shapes

// The Coolify mark: a cloud with the "C" cut out, one filled path in a 100 × 77 box scaled
// to the width it is given (the Dropbox plugin draws its bar icon the same way). The C is a
// second subpath in the same ShapePath; OddEvenFill punches it out of the cloud. Colour
// and size come from the caller: never a hardcoded colour here. `size` is the width; the
// height follows the 100:77 aspect, so a square slot never clips the ends.
Item {
  id: root
  property real size: 16
  property color color: "white"

  readonly property real sx: width / 100
  readonly property real sy: height / 77
  width: size
  height: size * 0.77
  implicitWidth: width
  implicitHeight: height

  Shape {
    anchors.fill: parent
    antialiasing: true
    layer.enabled: true
    layer.samples: 4
    ShapePath {
      fillColor: root.color
      strokeWidth: 0
      strokeColor: "transparent"
      // Two filled pieces, as in the reference: the body (the cloud minus the C channel,
      // traced as one outline) and the island inside the C with the right lobe. They touch
      // at one corner. The cloud is two circles, a left lobe (centre 23,49 r 19) and a top
      // lobe (centre 50,32 r 23), meeting at their intersection; the right lobe is a
      // semicircle (centre 85,43 r 13). No even-odd trick: a stroke leaving the cloud would fill.
      // body, clockwise from the bottom-left
      startX: 16 * root.sx; startY: 71 * root.sy
      PathCubic { control1X: 8 * root.sx; control1Y: 71 * root.sy; control2X: 4 * root.sx; control2Y: 62 * root.sy; x: 4 * root.sx; y: 49 * root.sy }   // lands at the left lobe's leftmost point, tangent to it
      PathArc   { x: 27.1 * root.sx; y: 30.4 * root.sy; radiusX: 19 * root.sx; radiusY: 19 * root.sy; direction: PathArc.Clockwise }
      PathArc   { x: 69.6 * root.sx; y: 20 * root.sy;   radiusX: 23 * root.sx; radiusY: 23 * root.sy; direction: PathArc.Clockwise }
      PathLine  { x: 43 * root.sx; y: 20 * root.sy }
      PathLine  { x: 43 * root.sx; y: 30 * root.sy }
      PathLine  { x: 33 * root.sx; y: 30 * root.sy }
      PathLine  { x: 33 * root.sx; y: 66 * root.sy }
      PathLine  { x: 92 * root.sx; y: 66 * root.sy }
      PathCubic { control1X: 92 * root.sx; control1Y: 69 * root.sy; control2X: 89 * root.sx; control2Y: 71 * root.sy; x: 86 * root.sx; y: 71 * root.sy }
      PathLine  { x: 16 * root.sx; y: 71 * root.sy }
      // island: the counter of the C with the right lobe
      PathMove  { x: 43 * root.sx; y: 30 * root.sy }
      PathLine  { x: 85 * root.sx; y: 30 * root.sy }
      PathArc   { x: 85 * root.sx; y: 56 * root.sy; radiusX: 13 * root.sx; radiusY: 13 * root.sy; direction: PathArc.Clockwise }
      PathLine  { x: 43 * root.sx; y: 56 * root.sy }
      PathLine  { x: 43 * root.sx; y: 30 * root.sy }
    }
  }
}
