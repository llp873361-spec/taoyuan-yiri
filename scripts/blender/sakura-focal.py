# 焦点樱花树（规格书 §12.1 阶段 12 CP3 返工）：RosticOstafi 的 "Tree Sakura"、"Sakura"（CC BY 4.0）只用树干和枝，花换成程序化的花卡。
#   树干：树根放到原点（最低那圈顶点的中心），缩放到目标高度，减面到约 9 千三角，带原来的树皮贴图和 UV；
#   花位：原模型的叶片卡每张取中心，换成一个很小的三角形（网页里只取它们的中心当花簇的位置，按位置聚成一团团花簇）；
#   两部分各是一个网格（名字"树干"、"花位"），导出到 assets/raw/built/sakura-focal-<名>.glb。
#   再把树干减到约 2800 三角导出一份 sakura-forest-<名>.glb：远景树林里成片的花树用它（2026-10-02 用户要把程序化的花树全换掉，
#   花园四周几百米内有一千多棵，全用 9 千三角的树干太重）
# 用法：blender --background --python scripts/blender/sakura-focal.py
import bpy, bmesh, os
from mathutils import Vector

ROOT = os.path.abspath( os.path.join( os.path.dirname( __file__ ), '..', '..' ) )
BUILT = os.path.join( ROOT, 'assets', 'raw', 'built' )
SOURCES = [
	# 名字、原始文件、目标高度（米）、树干三角预算
	( 'a', os.path.join( ROOT, 'assets', 'raw', 'sketchfab', 'sakura-rostic-tree', 'scene.gltf' ), 8.5, 9000 ),
	( 'b', os.path.join( ROOT, 'assets', 'raw', 'sketchfab', 'sakura-rostic', 'scene.gltf' ), 9.5, 9000 ),
]

# 树林用的低模树干三角预算
FOREST_BUDGET = 2800

def selectOnly( objects ):

	bpy.ops.object.select_all( action = 'DESELECT' )
	for item in objects:
		item.select_set( True )
	bpy.context.view_layer.objects.active = objects[ 0 ]

def triangleCount( item ):

	return sum( len( polygon.vertices ) - 2 for polygon in item.data.polygons )

for name, source, targetHeight, barkBudget in SOURCES:

	bpy.ops.wm.read_factory_settings( use_empty = True )
	bpy.ops.import_scene.gltf( filepath = source )
	meshes = [ item for item in bpy.data.objects if item.type == 'MESH' ]
	for item in meshes:
		world = item.matrix_world.copy()
		item.parent = None
		item.matrix_world = world
	selectOnly( meshes )
	bpy.ops.object.transform_apply( location = True, rotation = True, scale = True )
	for item in list( bpy.data.objects ):
		if item.type != 'MESH':
			bpy.data.objects.remove( item )

	bark = next( item for item in meshes if any( 'bark' in ( slot.material.name if slot.material else '' ).lower() for slot in item.material_slots ) )
	leaves = next( item for item in meshes if item is not bark )

	# 树根：树干最低 3% 高度以内的顶点的中心
	low = min( vertex.co.z for vertex in bark.data.vertices )
	high = max( max( vertex.co.z for vertex in item.data.vertices ) for item in meshes )
	band = low + ( high - low ) * 0.03
	foot = [ vertex.co for vertex in bark.data.vertices if vertex.co.z <= band ]
	root = Vector( ( sum( p.x for p in foot ) / len( foot ), sum( p.y for p in foot ) / len( foot ), low ) )
	scale = targetHeight / ( high - low )
	for item in meshes:
		for vertex in item.data.vertices:
			vertex.co = ( vertex.co - root ) * scale
	print( f'{ name }：原高 { high - low:.2f}，缩放 { scale:.2f} 倍到 { targetHeight } 米' )

	# 树干减面
	before = triangleCount( bark )
	if before > barkBudget:
		modifier = bark.modifiers.new( '减面', 'DECIMATE' )
		modifier.decimate_type = 'COLLAPSE'
		modifier.ratio = barkBudget / before
		modifier.use_collapse_triangulate = True
		selectOnly( [ bark ] )
		bpy.ops.object.modifier_apply( modifier = modifier.name )
	bark.name = '树干'
	bark.data.name = '树干'
	print( f'  树干 { before } → { triangleCount( bark ) } 三角' )

	# 花位：每张叶片卡（连通的几个面）取中心，换成一个边长 2 厘米的小三角形
	mesh = bmesh.new()
	mesh.from_mesh( leaves.data )
	mesh.faces.ensure_lookup_table()
	seen = set()
	centers = []
	for face in mesh.faces:
		if face.index in seen:
			continue
		stack = [ face ]
		seen.add( face.index )
		points = []
		while stack:
			current = stack.pop()
			points += [ vertex.co.copy() for vertex in current.verts ]
			for edge in current.edges:
				for neighbor in edge.link_faces:
					if neighbor.index not in seen:
						seen.add( neighbor.index )
						stack.append( neighbor )
		centers.append( sum( points, Vector() ) / len( points ) )
	mesh.free()
	markers = bmesh.new()
	for center in centers:
		a = markers.verts.new( center )
		b = markers.verts.new( center + Vector( ( 0.02, 0, 0 ) ) )
		c = markers.verts.new( center + Vector( ( 0, 0, 0.02 ) ) )
		markers.faces.new( ( a, b, c ) )
	markerMesh = bpy.data.meshes.new( '花位' )
	markers.to_mesh( markerMesh )
	markers.free()
	markerObject = bpy.data.objects.new( '花位', markerMesh )
	bpy.context.scene.collection.objects.link( markerObject )
	markerMesh.materials.append( bpy.data.materials.new( '花位' ) )
	bpy.data.objects.remove( leaves )
	print( f'  叶片卡 { len( centers ) } 张 → 花位' )

	os.makedirs( BUILT, exist_ok = True )
	path = os.path.join( BUILT, f'sakura-focal-{ name }.glb' )
	selectOnly( [ bark, markerObject ] )
	bpy.ops.export_scene.gltf( filepath = path, export_format = 'GLB', use_selection = True, export_yup = True, export_materials = 'EXPORT', export_tangents = False )
	print( f'  导出 { path }' )

	# 树林用的低模：树干是一千多段不连着的小枝管（每段六七个三角，减面减不动），按大小从小往大删细枝，删到 FOREST_BUDGET 三角为止；
	# 细枝本来就藏在花簇里，花位不变
	before = triangleCount( bark )
	mesh = bmesh.new()
	mesh.from_mesh( bark.data )
	mesh.faces.ensure_lookup_table()
	seen = set()
	islands = []
	for face in mesh.faces:
		if face.index in seen:
			continue
		stack = [ face ]
		seen.add( face.index )
		faces = []
		while stack:
			current = stack.pop()
			faces.append( current )
			for edge in current.edges:
				for neighbor in edge.link_faces:
					if neighbor.index not in seen:
						seen.add( neighbor.index )
						stack.append( neighbor )
		points = [ vertex.co for item in faces for vertex in item.verts ]
		low = Vector( ( min( p.x for p in points ), min( p.y for p in points ), min( p.z for p in points ) ) )
		high = Vector( ( max( p.x for p in points ), max( p.y for p in points ), max( p.z for p in points ) ) )
		islands.append( ( ( high - low ).length, faces ) )
	islands.sort( key = lambda item: item[ 0 ] )
	remaining = sum( len( item.verts ) - 2 for item in mesh.faces )
	doomed = []
	for size, faces in islands:
		if remaining <= FOREST_BUDGET:
			break
		doomed += faces
		remaining -= sum( len( item.verts ) - 2 for item in faces )
	bmesh.ops.delete( mesh, geom = doomed, context = 'FACES' )
	mesh.to_mesh( bark.data )
	mesh.free()
	print( f'  树林用：树干 { before } → { triangleCount( bark ) } 三角（删了 { len( islands ) } 段里最小的那些）' )
	path = os.path.join( BUILT, f'sakura-forest-{ name }.glb' )
	selectOnly( [ bark, markerObject ] )
	bpy.ops.export_scene.gltf( filepath = path, export_format = 'GLB', use_selection = True, export_yup = True, export_materials = 'EXPORT', export_tangents = False )
	print( f'  导出 { path }' )
