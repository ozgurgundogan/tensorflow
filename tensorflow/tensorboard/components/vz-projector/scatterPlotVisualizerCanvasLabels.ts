/* Copyright 2016 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/

import {HoverContext} from './hoverContext';
import {NearestEntry} from './knn';
import {BoundingBox, CollisionGrid} from './label';
import {RenderContext} from './renderContext';
import {DataSet} from './scatterPlot';
import {ScatterPlotVisualizer} from './scatterPlotVisualizer';
import {SelectionContext} from './selectionContext';
import {getProjectedPointFromIndex, vector3DToScreenCoords} from './util';
import {Point2D} from './vector';

const LABEL_COLOR = 0x000000;
const LABEL_STROKE = 0xffffff;

// The maximum number of labels to draw to keep the frame rate up.
const SAMPLE_SIZE = 10000;

const FONT_SIZE = 10;

/**
 * Creates and maintains a 2d canvas on top of the GL canvas. All labels, when
 * active, are rendered to the 2d canvas as part of the visible render pass.
 */
export class ScatterPlotVisualizerCanvasLabels implements
    ScatterPlotVisualizer {
  private dataSet: DataSet;
  private selectedPointIndices: number[] = [];
  private neighborsOfFirstPoint: NearestEntry[] = [];
  private hoverPointIndex: number;
  private gc: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private labelCanvasIsCleared = true;
  private labelColor: number = LABEL_COLOR;
  private labelStroke: number = LABEL_STROKE;
  private labelsActive: boolean = true;
  private sceneIs3D: boolean = true;

  constructor(
      container: d3.Selection<any>, selectionContext: SelectionContext,
      hoverContext: HoverContext) {
    selectionContext.registerSelectionChangedListener(
        (s: number[], n: NearestEntry[]) => {
          this.selectedPointIndices = s;
          this.neighborsOfFirstPoint = n;
        });
    hoverContext.registerHoverListener((h: number) => {
      this.hoverPointIndex = h;
    });
    this.canvas = container.append('canvas').node() as HTMLCanvasElement;
    this.gc = this.canvas.getContext('2d');
    d3.select(this.canvas).style({position: 'absolute', left: 0, top: 0});
    this.canvas.style.pointerEvents = 'none';
  }

  private removeAllLabels() {
    // If labels are already removed, do not spend compute power to clear the
    // canvas.
    let pixelWidth = this.canvas.width * window.devicePixelRatio;
    let pixelHeight = this.canvas.height * window.devicePixelRatio;
    if (!this.labelCanvasIsCleared) {
      this.gc.clearRect(0, 0, pixelWidth, pixelHeight);
      this.labelCanvasIsCleared = true;
    }
  }

  private createLabelsForNeighborPoints(
      labelAccessor: (index: number) => string, camera: THREE.Camera,
      cameraTarget: THREE.Vector3, screenWidth: number, screenHeight: number,
      nearestPointZ: number, farthestPointZ: number, strokeStylePrefix: string,
      fillStylePrefix: string) {
    let labelIndices: number[] = [];
    this.selectedPointIndices.forEach(i => labelIndices.push(i));
    this.neighborsOfFirstPoint.forEach(n => labelIndices.push(n.index));
    this.labelCanvasIsCleared = false;

    if (labelIndices.length === 0) {
      return;
    }

    // We never render more than ~500 labels, so when we get much past that
    // point, just break.
    let numRenderedLabels: number = 0;
    const labelHeight = parseInt(this.gc.font, 10);
    const dpr = window.devicePixelRatio;
    const pixelWidth = this.canvas.width * dpr;
    const pixelHeight = this.canvas.height * dpr;

    // Bounding box for collision grid.
    const boundingBox:
        BoundingBox = {loX: 0, hiX: pixelWidth, loY: 0, hiY: pixelHeight};

    // Make collision grid with cells proportional to window dimensions.
    let grid =
        new CollisionGrid(boundingBox, pixelWidth / 25, pixelHeight / 50);

    const opacityRange = farthestPointZ - nearestPointZ;
    const camToTarget =
        new THREE.Vector3().copy(camera.position).sub(cameraTarget);

    this.gc.lineWidth = 6;
    this.gc.textBaseline = 'middle';
    this.gc.font = (FONT_SIZE * dpr).toString() + 'px roboto';

    // Have extra space between neighboring labels. Don't pack too tightly.
    let labelMargin = 2;
    // Shift the label to the right of the point circle.
    let xShift = 3;

    for (let i = 0;
         (i < labelIndices.length) && (numRenderedLabels < SAMPLE_SIZE); i++) {
      const index = labelIndices[i];
      const point = getProjectedPointFromIndex(this.dataSet, index);
      // discard points that are behind the camera
      const camToPoint = new THREE.Vector3().copy(camera.position).sub(point);
      if (camToTarget.dot(camToPoint) < 0) {
        continue;
      }
      const screenCoords =
          vector3DToScreenCoords(camera, screenWidth, screenHeight, point);
      const textBoundingBox = {
        loX: screenCoords[0] + xShift - labelMargin,
        // Computing the width of the font is expensive,
        // so we assume width of 1 at first. Then, if the label doesn't
        // conflict with other labels, we measure the actual width.
        hiX: screenCoords[0] + xShift + 1 + labelMargin,
        loY: screenCoords[1] - labelHeight / 2 - labelMargin,
        hiY: screenCoords[1] + labelHeight / 2 + labelMargin
      };

      if (grid.insert(textBoundingBox, true)) {
        let text = labelAccessor(index);
        let labelWidth = this.gc.measureText(text).width;

        // Now, check with properly computed width.
        textBoundingBox.hiX += labelWidth - 1;
        if (grid.insert(textBoundingBox)) {
          let p = new THREE.Vector3(point[0], point[1], point[2]);
          let lenToCamera = camera.position.distanceTo(p);
          // Opacity is scaled between 0.2 and 1, based on how far a label is
          // from the camera (Unless we are in 2d mode, in which case opacity is
          // just 1!)
          let opacity = this.sceneIs3D ?
              1.2 - (lenToCamera - nearestPointZ) / opacityRange :
              1;
          this.formatLabel(
              text, screenCoords, strokeStylePrefix, fillStylePrefix, opacity);
          numRenderedLabels++;
        }
      }
    }
  }

  /**
   * Reset the positions of all labels, and check for overlapps using the
   * collision grid.
   */
  private makeLabels(
      labelAccessor: (index: number) => string, camera: THREE.Camera,
      cameraTarget: THREE.Vector3, screenWidth: number, screenHeight: number,
      nearestPointZ: number, farthestPointZ: number) {
    this.removeAllLabels();

    let strokeStylePrefix: string;
    let fillStylePrefix: string;
    {
      const ls = new THREE.Color(this.labelStroke).multiplyScalar(255);
      const lc = new THREE.Color(this.labelColor).multiplyScalar(255);
      strokeStylePrefix = 'rgba(' + ls.r + ',' + ls.g + ',' + ls.b + ',';
      fillStylePrefix = 'rgba(' + lc.r + ',' + lc.g + ',' + lc.b + ',';
    }

    this.createLabelsForNeighborPoints(
        labelAccessor, camera, cameraTarget, screenWidth, screenHeight,
        nearestPointZ, farthestPointZ, strokeStylePrefix, fillStylePrefix);

    // Render the non-clipped 'important' entries with a bigger font.
    {
      const dpr = window.devicePixelRatio;
      const bigEntries: number[] = [];
      if (this.hoverPointIndex) {
        bigEntries.push(this.hoverPointIndex);
      }
      if (this.selectedPointIndices.length === 1) {
        bigEntries.push(this.selectedPointIndices[0]);
      }

      for (let i = 0; i < bigEntries.length; ++i) {
        const index = bigEntries[i];
        const pp = this.dataSet.points[index].projectedPoint;
        this.gc.font = (FONT_SIZE * dpr * 1.7) + 'px roboto';
        const coords = new THREE.Vector3(pp[0], pp[1], pp[2]);
        const screenCoords =
            vector3DToScreenCoords(camera, screenWidth, screenHeight, coords);
        const text = labelAccessor(index);
        this.formatLabel(
            text, screenCoords, strokeStylePrefix, fillStylePrefix, 1);
      }
    }
  }

  /** Add a specific label to the canvas. */
  private formatLabel(
      text: string, point: Point2D, strokeStylePrefix: string,
      fillStylePrefix: string, opacity: number) {
    this.gc.strokeStyle = strokeStylePrefix + opacity + ')';
    this.gc.fillStyle = fillStylePrefix + opacity + ')';
    this.gc.strokeText(text, point[0] + 4, point[1]);
    this.gc.fillText(text, point[0] + 4, point[1]);
  }

  onDataSet(dataSet: DataSet, spriteImage: HTMLImageElement) {
    this.labelsActive = (spriteImage == null);
    this.dataSet = dataSet;
  }

  onResize(newWidth: number, newHeight: number) {
    let dpr = window.devicePixelRatio;
    d3.select(this.canvas)
        .attr('width', newWidth * dpr)
        .attr('height', newHeight * dpr)
        .style({width: newWidth + 'px', height: newHeight + 'px'});
  }

  onRecreateScene(
      scene: THREE.Scene, sceneIs3D: boolean, backgroundColor: number) {
    this.sceneIs3D = sceneIs3D;
  }

  removeAllFromScene(scene: THREE.Scene) {
    this.removeAllLabels();
  }

  onUpdate() {
    this.removeAllLabels();
  }

  onRender(rc: RenderContext) {
    if (this.labelsActive) {
      this.makeLabels(
          rc.labelAccessor, rc.camera, rc.cameraTarget, rc.screenWidth,
          rc.screenHeight, rc.nearestCameraSpacePointZ,
          rc.farthestCameraSpacePointZ);
    }
  }

  onPickingRender(camera: THREE.Camera, cameraTarget: THREE.Vector3) {}
  onSetLabelAccessor(labelAccessor: (index: number) => string) {}
}
