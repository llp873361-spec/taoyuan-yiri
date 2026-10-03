# 看一个 glTF / glb 模型的结构：每个网格的三角数、材质、包围盒，再渲一张 Workbench 预览图
# blender --background --python scripts/blender/inspect-model.py -- 模型路径 预览图路径
import bpy, sys, json, math
from mathutils import Vector

args = sys.argv[ sys.argv.index( "--" ) + 1: ]
modelPath = args[ 0 ]
previewPath = args[ 1 ] if len( args ) > 1 else None

bpy.ops.wm.read_factory_settings( use_empty = True )
bpy.ops.import_scene.gltf( filepath = modelPath )

report = []
low = Vector( ( 1e9, 1e9, 1e9 ) )
high = Vector( ( - 1e9, - 1e9, - 1e9 ) )
for obj in bpy.data.objects:
	if obj.type != "MESH": continue
	mesh = obj.data
	triangles = sum( len( p.vertices ) - 2 for p in mesh.polygons )
	corners = [ obj.matrix_world @ Vector( c ) for c in obj.bound_box ]
	for c in corners:
		low = Vector( map( min, low, c ) )
		high = Vector( map( max, high, c ) )
	objLow = Vector( ( min( c.x for c in corners ), min( c.y for c in corners ), min( c.z for c in corners ) ) )
	objHigh = Vector( ( max( c.x for c in corners ), max( c.y for c in corners ), max( c.z for c in corners ) ) )
	report.append( {
		"网格": obj.name,
		"三角": triangles,
		"顶点": len( mesh.vertices ),
		"材质": [ m.name if m else None for m in mesh.materials ],
		"UV 层": len( mesh.uv_layers ),
		"颜色属性": [ a.name for a in mesh.color_attributes ],
		"包围盒": [ [ round( v, 2 ) for v in objLow ], [ round( v, 2 ) for v in objHigh ] ],
	} )

print( "__RESULT__" + json.dumps( { "网格": report, "总包围盒": [ [ round( v, 2 ) for v in low ], [ round( v, 2 ) for v in high ] ], "总三角": sum( r[ "三角" ] for r in report ) }, ensure_ascii = False ) )

if previewPath:
	size = high - low
	center = ( high + low ) / 2
	scene = bpy.context.scene
	scene.render.engine = "BLENDER_WORKBENCH"
	scene.display.shading.light = "STUDIO"
	scene.display.shading.color_type = "TEXTURE"
	scene.render.resolution_x = 1200
	scene.render.resolution_y = 900
	scene.render.film_transparent = False
	camera = bpy.data.objects.new( "预览相机", bpy.data.cameras.new( "预览相机" ) )
	scene.collection.objects.link( camera )
	scene.camera = camera
	radius = max( size.x, size.y, size.z )
	camera.location = center + Vector( ( radius * 1.1, - radius * 1.6, radius * 0.35 ) )
	direction = center - camera.location
	camera.rotation_euler = direction.to_track_quat( "-Z", "Y" ).to_euler()
	camera.data.lens = 50
	scene.render.filepath = previewPath
	bpy.ops.render.render( write_still = True )
