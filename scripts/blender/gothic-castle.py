# 哥特城堡（规格书 11.2，阶段 12 CP4 提前做）：用 chambersu1996 的零件包 "Gothic Building For Aria Pack 1.0"（CC BY 4.0）拼一座城堡。
# 在 Blender 里跑（本机 Blender 4.2 LTS）：
#   blender --background --python scripts/blender/gothic-castle.py -- --preview       只出构图预览图（reference/tmp-headless/gothic-castle/）
#   blender --background --python scripts/blender/gothic-castle.py                    拼好、烘 AO、窗户编号、三级减面，导出到 assets/raw/built/
# 零件包里摆着一排做好的成品（主尖塔、几座副塔、带飞扶壁的中殿剖面、山墙……），单位厘米、y 向上（导进 Blender 后 z 向上）。
# 这里按包围盒把每个成品挑出来，按 layout 复制、缩放、摆放。城堡自己的坐标：x 向右（从湖对岸机位看）、−y 朝机位、z 向上，底面中心在原点；
# 导出成 glTF 后是 +z 朝机位，和 gothic.js 里城堡"本地 +z 朝机位"的约定一样

import bpy
import bmesh
import sys
import os
import math
from mathutils import Vector, Matrix

PROJECT = os.path.abspath( os.path.join( os.path.dirname( __file__ ), '..', '..' ) )
KIT = os.path.join( PROJECT, 'assets', 'raw', 'sketchfab', 'gothic-aria-kit', 'scene.gltf' )
BUILT = os.path.join( PROJECT, 'assets', 'raw', 'built' )
PREVIEW = os.path.join( PROJECT, 'reference', 'tmp-headless', 'gothic-castle' )
arguments = sys.argv[ sys.argv.index( '--' ) + 1: ] if '--' in sys.argv else []
previewOnly = '--preview' in arguments

# ===================== 零件 =====================
# 零件包里的成品：包围盒中心落在 box 里的网格算这一块（零件包坐标，米：x 向右、y 向上、z 朝外），anchor 是这一块的底面中心
pieces = {
	'mainTower': { 'box': ( ( 111, -1, -9 ), ( 129, 160, 9 ) ), 'anchor': ( 120, 0, 0 ) },            # 主尖塔：三层塔身 + 高尖顶，153 米
	'spireTower': { 'box': ( ( 72, -1, -8 ), ( 88, 70, 8 ) ), 'anchor': ( 80, 0, 0 ) },              # 带尖顶的塔，68 米
	'slimSpire': { 'box': ( ( 94, -1, -6 ), ( 106, 90, 6 ) ), 'anchor': ( 100, 0, 0 ) },             # 细高尖塔，85 米
	'towerBase': { 'box': ( ( 52, -1, -8 ), ( 68, 27.4, 8 ) ), 'anchor': ( 60, 0, 0 ) },             # 方塔塔身（四角小尖塔），27 米
	'towerCrown': { 'box': ( ( 54, 27.4, -6 ), ( 66, 41, 6 ) ), 'anchor': ( 60, 28, 0 ) },           # 方塔的灯笼顶，12 米
	'pavilion': { 'box': ( ( 33, -1, -7 ), ( 47, 26, 7 ) ), 'anchor': ( 40, 0, 0 ) },                # 带坡顶的方楼，25 米
	'chapel': { 'box': ( ( 14.5, -1, -5.5 ), ( 25.5, 34, 5.5 ) ), 'anchor': ( 20, 0, 0 ) },          # 小礼拜堂（尖顶），34 米
	'naveBay': { 'box': ( ( 222, -1, -10.5 ), ( 298, 67, 0.5 ) ), 'anchor': ( 260, 0, -4.95 ) },     # 中殿一跨的横剖面：两边飞扶壁 + 屋架，74 米宽、9.9 米一跨
	'aisleBay': { 'box': ( ( 192, -1, -10.5 ), ( 222, 53, 0.5 ) ), 'anchor': ( 207, 0, -4.95 ) },    # 半边的剖面（一侧飞扶壁），29 米宽
	'gable': { 'box': ( ( 164, -1, -8.5 ), ( 186, 28, -1.5 ) ), 'anchor': ( 175, 0, -5 ) },          # 山墙（屋架 + 尖拱），21 米宽
}

# ===================== 布局 =====================
# 每一项：零件、位置（城堡坐标，米）、绕 z 转多少度、缩放。构图（从湖对岸往上看）：
#   主尖塔在中间偏左，最高；右边一段 5 跨的高殿、左边一段 3 跨的矮殿，一前一后错开；后排三座高低不一的细高尖塔，两头各一座带尖顶的塔（尖塔林立）；
#   前沿（靠崖边）一排矮的：方塔加灯笼顶、方楼、小礼拜堂，挡住殿身的基座，前低后高。整座再转 turnAll 度，从机位看是 3/4 侧面，飞扶壁有进深
kitScale = 0.55
bayLength = 9.9 * kitScale
turnAll = -22
layout = []

def nave( count, startX, y, scale ):

	length = 9.9 * scale
	for bay in range( count ):
		layout.append( { 'piece': 'naveBay', 'at': ( startX + ( bay + 0.5 ) * length, y, 0 ), 'turn': 90, 'scale': scale } )
	return startX + count * length

highNaveEnd = nave( 5, 2, 6, kitScale )
lowNaveStart = -2 - 3 * 9.9 * 0.44
nave( 3, lowNaveStart, -4, 0.44 )
layout += [
	{ 'piece': 'mainTower', 'at': ( -4, 2, 0 ), 'turn': 0, 'scale': kitScale },
	{ 'piece': 'slimSpire', 'at': ( 16, 30, 0 ), 'turn': 12, 'scale': kitScale * 1.2 },
	{ 'piece': 'slimSpire', 'at': ( -26, 24, 0 ), 'turn': 30, 'scale': kitScale * 1.0 },
	{ 'piece': 'slimSpire', 'at': ( highNaveEnd + 10, 24, 0 ), 'turn': -15, 'scale': kitScale * 0.9 },
	{ 'piece': 'spireTower', 'at': ( highNaveEnd + 4, 4, 0 ), 'turn': 0, 'scale': kitScale * 1.05 },
	{ 'piece': 'spireTower', 'at': ( lowNaveStart - 5, -8, 0 ), 'turn': 0, 'scale': kitScale * 0.9 },
	{ 'piece': 'towerBase', 'at': ( -20, -27, 0 ), 'turn': 0, 'scale': kitScale },
	{ 'piece': 'towerCrown', 'at': ( -20, -27, 26.8 * kitScale ), 'turn': 0, 'scale': kitScale },
	{ 'piece': 'towerBase', 'at': ( -36, -18, 0 ), 'turn': 30, 'scale': kitScale * 0.85 },
	{ 'piece': 'pavilion', 'at': ( 4, -26, 0 ), 'turn': 0, 'scale': kitScale * 1.1 },
	{ 'piece': 'chapel', 'at': ( 22, -24, 0 ), 'turn': 90, 'scale': kitScale * 1.1 },
	{ 'piece': 'pavilion', 'at': ( 36, -14, 0 ), 'turn': 15, 'scale': kitScale * 0.9 },
]

# ===================== 导入 =====================

def importKit():

	bpy.ops.wm.read_factory_settings( use_empty = True )
	bpy.ops.import_scene.gltf( filepath = KIT )
	meshes = [ item for item in bpy.context.scene.objects if item.type == 'MESH' ]
	# 层级的变换烘进网格：先断开父子（保持世界位置），每个物体的网格单独一份，再应用变换；厘米换成米
	for item in meshes:
		world = item.matrix_world.copy()
		item.parent = None
		item.matrix_world = Matrix.Scale( 0.01, 4 ) @ world
	for item in list( bpy.context.scene.objects ):
		if item.type != 'MESH':
			bpy.data.objects.remove( item, do_unlink = True )
	bpy.ops.object.select_all( action = 'DESELECT' )
	for item in meshes:
		item.select_set( True )
	bpy.context.view_layer.objects.active = meshes[ 0 ]
	bpy.ops.object.make_single_user( object = True, obdata = True )
	bpy.ops.object.transform_apply( location = True, rotation = True, scale = True )
	print( f'零件包导入：{ len( meshes ) } 个网格' )
	return meshes

# Blender 坐标（z 向上）→ 零件包坐标（y 向上）：x 不变、y = z、z = −y
def toKit( point ):

	return ( point.x, point.z, - point.y )

def kitToBlender( point ):

	return Vector( ( point[ 0 ], - point[ 2 ], point[ 1 ] ) )

def boundsCenter( item ):

	corners = [ item.matrix_world @ Vector( corner ) for corner in item.bound_box ]
	low = Vector( ( min( c.x for c in corners ), min( c.y for c in corners ), min( c.z for c in corners ) ) )
	high = Vector( ( max( c.x for c in corners ), max( c.y for c in corners ), max( c.z for c in corners ) ) )
	return ( low + high ) / 2

def selectPiece( meshes, name ):

	low, high = pieces[ name ][ 'box' ]
	chosen = []
	for item in meshes:
		center = toKit( boundsCenter( item ) )
		if all( low[ k ] <= center[ k ] <= high[ k ] for k in range( 3 ) ):
			chosen.append( item )
	if not chosen:
		raise RuntimeError( f'零件「{ name }」一个网格都没挑到，检查 box' )
	return chosen

# ===================== 拼 =====================

def assemble( meshes ):

	selections = { name: selectPiece( meshes, name ) for name in pieces }
	for name, chosen in selections.items():
		print( f'  零件 { name }：{ len( chosen ) } 个网格' )
	placed = []
	for entry in layout:
		anchor = kitToBlender( pieces[ entry[ 'piece' ] ][ 'anchor' ] )
		transform = Matrix.Rotation( math.radians( turnAll ), 4, 'Z' ) @ Matrix.Translation( Vector( entry[ 'at' ] ) ) @ Matrix.Rotation( math.radians( entry[ 'turn' ] ), 4, 'Z' ) @ Matrix.Scale( entry[ 'scale' ], 4 ) @ Matrix.Translation( - anchor )
		for source in selections[ entry[ 'piece' ] ]:
			copy = source.copy()
			copy.data = source.data.copy()
			bpy.context.scene.collection.objects.link( copy )
			copy.data.transform( transform )
			copy.matrix_world = Matrix.Identity( 4 )
			placed.append( copy )
	# 零件包原来那一排删掉
	for item in meshes:
		bpy.data.objects.remove( item, do_unlink = True )
	print( f'拼好：{ len( placed ) } 个网格，{ sum( len( item.data.polygons ) for item in placed ) } 个面' )
	return placed

# ===================== 预览 =====================
# Workbench 渲染（不要显卡光追）：湖对岸机位的方向（城堡在 570 米外、机位比城堡脚低 88 米）一张原样构图、一张拉近，再从侧面一张看进深

def preview( placed ):

	os.makedirs( PREVIEW, exist_ok = True )
	scene = bpy.context.scene
	scene.render.engine = 'BLENDER_WORKBENCH'
	scene.display.shading.light = 'STUDIO'
	scene.display.shading.color_type = 'MATERIAL'
	scene.display.shading.show_cavity = True
	scene.display.shading.show_shadows = True
	scene.render.resolution_x = 1600
	scene.render.resolution_y = 900
	world = bpy.data.worlds.new( '预览天' )
	world.color = ( 0.08, 0.1, 0.18 )
	scene.world = world
	# 窗玻璃在预览里涂成暖黄，看得出窗在哪
	for material in bpy.data.materials:
		if 'Glass' in material.name:
			material.diffuse_color = ( 1.0, 0.7, 0.3, 1 )
	camera = bpy.data.objects.new( '预览相机', bpy.data.cameras.new( '预览相机' ) )
	scene.collection.objects.link( camera )
	scene.camera = camera
	camera.data.sensor_fit = 'VERTICAL'
	views = [
		( '机位原样', Vector( ( 0, -570, -86 ) ), Vector( ( 0, 0, 40 ) ), 50 ),
		( '拉近', Vector( ( 0, -570, -86 ) ) * 0.42, Vector( ( 0, 0, 38 ) ), 26 ),
		( '侧面', Vector( ( 300, -260, 20 ) ), Vector( ( 0, 0, 30 ) ), 30 ),
	]
	for name, position, target, fov in views:
		camera.location = position
		direction = target - position
		camera.rotation_euler = direction.to_track_quat( '-Z', 'Y' ).to_euler()
		camera.data.angle = math.radians( fov )
		camera.data.clip_end = 5000
		scene.render.filepath = os.path.join( PREVIEW, name + '.png' )
		bpy.ops.render.render( write_still = True )
		print( '预览：' + scene.render.filepath )

# ===================== 处理 =====================

# 选中这些物体（别的都不选），第一个当活动物体
def selectOnly( objects ):

	bpy.ops.object.select_all( action = 'DESELECT' )
	for item in objects:
		item.select_set( True )
	bpy.context.view_layer.objects.active = objects[ 0 ]

def triangleCount( item ):

	return sum( len( polygon.vertices ) - 2 for polygon in item.data.polygons )

# 合成一个网格、焊接重合的顶点，再按材质拆成石头（Dark + Light）和窗玻璃（Glass）
def joinAndSplit( placed ):

	selectOnly( placed )
	bpy.ops.object.join()
	castle = bpy.context.view_layer.objects.active
	castle.name = '城堡'
	mesh = bmesh.new()
	mesh.from_mesh( castle.data )
	bmesh.ops.remove_doubles( mesh, verts = mesh.verts, dist = 0.002 )
	mesh.to_mesh( castle.data )
	mesh.free()
	selectOnly( [ castle ] )
	bpy.ops.object.mode_set( mode = 'EDIT' )
	bpy.ops.mesh.select_all( action = 'DESELECT' )
	glassIndex = next( index for index, material in enumerate( castle.data.materials ) if 'Glass' in material.name )
	castle.active_material_index = glassIndex
	bpy.ops.object.material_slot_select()
	bpy.ops.mesh.separate( type = 'SELECTED' )
	bpy.ops.object.mode_set( mode = 'OBJECT' )
	glass = next( item for item in bpy.context.selected_objects if item != castle )
	glass.name = '窗玻璃'
	print( f'石头 { triangleCount( castle ) } 三角，窗玻璃 { triangleCount( glass ) } 三角' )
	return castle, glass

# 减面（塌边），顶点色跟着插值；ratio 按目标三角数算
def decimate( item, targetTriangles ):

	current = triangleCount( item )
	if current <= targetTriangles:
		return
	modifier = item.modifiers.new( '减面', 'DECIMATE' )
	modifier.decimate_type = 'COLLAPSE'
	modifier.ratio = targetTriangles / current
	modifier.use_collapse_triangulate = True
	selectOnly( [ item ] )
	bpy.ops.object.modifier_apply( modifier = modifier.name )
	print( f'  { item.name }：{ current } → { triangleCount( item ) } 三角' )

# 删掉包围盒对角线小于 minSize 米的碎件（连通块）：塌边减面对一堆互不相连的小零件减不下去，低模先把看不见的小尖饰、窗棂、栏杆去掉
def dropSmallParts( item, minSize ):

	mesh = bmesh.new()
	mesh.from_mesh( item.data )
	mesh.faces.ensure_lookup_table()
	seen = set()
	doomed = []
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
		points = [ vertex.co for f in faces for vertex in f.verts ]
		low = Vector( ( min( p.x for p in points ), min( p.y for p in points ), min( p.z for p in points ) ) )
		high = Vector( ( max( p.x for p in points ), max( p.y for p in points ), max( p.z for p in points ) ) )
		if ( high - low ).length < minSize:
			doomed += faces
	before = len( mesh.faces )
	bmesh.ops.delete( mesh, geom = doomed, context = 'FACES' )
	mesh.to_mesh( item.data )
	mesh.free()
	print( f'  { item.name }：删掉小于 { minSize } 米的碎件，{ before } → { len( item.data.polygons ) } 个面' )

# 远景替身：体素重建成一个实心外壳（voxelSize 米一格，只留轮廓），再减面；AO 顶点色从原来的网格按最近的面插值转过来
def silhouetteShell( source, voxelSize, targetTriangles ):

	shell = source.copy()
	shell.data = source.data.copy()
	bpy.context.scene.collection.objects.link( shell )
	shell.name = '替身外壳'
	remesh = shell.modifiers.new( '体素重建', 'REMESH' )
	remesh.mode = 'VOXEL'
	remesh.voxel_size = voxelSize
	selectOnly( [ shell ] )
	bpy.ops.object.modifier_apply( modifier = remesh.name )
	decimate( shell, targetTriangles )
	shell.data.color_attributes.new( 'Col', 'BYTE_COLOR', 'POINT' )
	shell.data.color_attributes.active_color = shell.data.color_attributes[ 'Col' ]
	transfer = shell.modifiers.new( '转 AO', 'DATA_TRANSFER' )
	transfer.object = source
	transfer.use_vert_data = True
	transfer.data_types_verts = { 'COLOR_VERTEX' }
	transfer.vert_mapping = 'POLYINTERP_NEAREST'
	bpy.ops.object.modifier_apply( modifier = transfer.name )
	# 材质：全用石头那一种（体素重建以后材质槽只剩第一个）
	print( f'  替身外壳：{ triangleCount( shell ) } 三角' )
	return shell

# 环境光遮蔽烘进顶点色（Cycles，AO 距离 5 米、32 次采样）：凹进去的拱门、檐下、扶壁之间、塔脚变暗；窗玻璃也挡光
def bakeAmbientOcclusion( item ):

	scene = bpy.context.scene
	scene.render.engine = 'CYCLES'
	scene.cycles.device = 'CPU'
	scene.cycles.samples = 32
	if scene.world is None:
		scene.world = bpy.data.worlds.new( '烘焙' )
	scene.world.light_settings.distance = 5
	scene.render.bake.target = 'VERTEX_COLORS'
	attribute = item.data.color_attributes.new( 'Col', 'BYTE_COLOR', 'POINT' )
	item.data.color_attributes.active_color = attribute
	selectOnly( [ item ] )
	bpy.ops.object.bake( type = 'AO' )
	print( f'  AO 烘进了 { item.name } 的顶点色' )

# 窗玻璃按连通块编号：一块玻璃是一格窗（窗棂把一扇窗分成几格）；中心离得近（1.8 米内）、朝向差不多的几格算同一个房间（一起亮）。
# 每个顶点写 _window = (房间号, 格号, 离地高度 / 城堡总高, 房间的随机数)，导出成 glTF 的 _WINDOW 属性；返回房间表
def labelWindows( glass, castleHeight ):

	mesh = bmesh.new()
	mesh.from_mesh( glass.data )
	mesh.faces.ensure_lookup_table()
	islands = []
	seen = set()
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
		area = sum( f.calc_area() for f in faces ) or 1e-6
		center = sum( ( f.calc_center_median() * f.calc_area() for f in faces ), Vector() ) / area
		normal = sum( ( f.normal * f.calc_area() for f in faces ), Vector() )
		normal = normal.normalized() if normal.length > 0 else Vector( ( 0, -1, 0 ) )
		islands.append( { 'faces': faces, 'center': center, 'normal': normal, 'area': area } )
	# 房间：按 1.8 米的格子找邻居，并查集合并
	parent = list( range( len( islands ) ) )

	def find( index ):

		while parent[ index ] != index:
			parent[ index ] = parent[ parent[ index ] ]
			index = parent[ index ]
		return index

	def cellOf( point ):

		return tuple( int( math.floor( value / 1.8 ) ) for value in point )

	cells = {}
	for index, island in enumerate( islands ):
		cells.setdefault( cellOf( island[ 'center' ] ), [] ).append( index )
	for index, island in enumerate( islands ):
		key = cellOf( island[ 'center' ] )
		for a in ( -1, 0, 1 ):
			for b in ( -1, 0, 1 ):
				for c in ( -1, 0, 1 ):
					for other in cells.get( ( key[ 0 ] + a, key[ 1 ] + b, key[ 2 ] + c ), [] ):
						if other <= index:
							continue
						if ( islands[ other ][ 'center' ] - island[ 'center' ] ).length < 1.8 and islands[ other ][ 'normal' ].dot( island[ 'normal' ] ) > 0.7:
							parent[ find( other ) ] = find( index )
	rooms = {}
	for index in range( len( islands ) ):
		rooms.setdefault( find( index ), [] ).append( index )
	roomList = []
	attribute = glass.data.attributes.new( '_window', 'FLOAT_COLOR', 'POINT' )
	values = [ 0.0 ] * ( len( glass.data.vertices ) * 4 )
	for roomIndex, members in enumerate( rooms.values() ):
		area = sum( islands[ m ][ 'area' ] for m in members )
		center = sum( ( islands[ m ][ 'center' ] * islands[ m ][ 'area' ] for m in members ), Vector() ) / area
		normal = sum( ( islands[ m ][ 'normal' ] * islands[ m ][ 'area' ] for m in members ), Vector() ).normalized()
		randomValue = ( math.sin( roomIndex * 12.9898 + 78.233 ) * 43758.5453 ) % 1.0
		roomList.append( { 'center': center, 'normal': normal, 'area': area } )
		for member in members:
			for face in islands[ member ][ 'faces' ]:
				for vertex in face.verts:
					values[ vertex.index * 4: vertex.index * 4 + 4 ] = [ roomIndex, member, max( 0.0, center.z ) / castleHeight, randomValue ]
	mesh.free()
	attribute.data.foreach_set( 'color', values )
	print( f'  窗玻璃：{ len( islands ) } 格、{ len( roomList ) } 个房间' )
	return roomList

# 低模的窗：每个房间一块朝外的竖长方片（面积和那间的玻璃一样），带同样的 _window 属性，远景替身用
def roomQuads( roomList, castleHeight, material ):

	mesh = bpy.data.meshes.new( '窗片' )
	vertices = []
	faces = []
	values = []
	for roomIndex, room in enumerate( roomList ):
		normal = room[ 'normal' ]
		side = Vector( ( 0, 0, 1 ) ).cross( normal )
		side = side.normalized() if side.length > 1e-3 else Vector( ( 1, 0, 0 ) )
		up = normal.cross( side ).normalized()
		halfWidth = math.sqrt( room[ 'area' ] / 2.5 ) / 2
		halfHeight = halfWidth * 2.5
		center = room[ 'center' ] + normal * 0.05
		start = len( vertices )
		for a, b in ( ( -1, -1 ), ( 1, -1 ), ( 1, 1 ), ( -1, 1 ) ):
			vertices.append( center + side * a * halfWidth + up * b * halfHeight )
		faces.append( ( start, start + 1, start + 2, start + 3 ) )
		randomValue = ( math.sin( roomIndex * 12.9898 + 78.233 ) * 43758.5453 ) % 1.0
		values += [ roomIndex, roomIndex, max( 0.0, room[ 'center' ].z ) / castleHeight, randomValue ] * 4
	mesh.from_pydata( vertices, [], faces )
	mesh.materials.append( material )
	attribute = mesh.attributes.new( '_window', 'FLOAT_COLOR', 'POINT' )
	attribute.data.foreach_set( 'color', values )
	item = bpy.data.objects.new( '窗片', mesh )
	bpy.context.scene.collection.objects.link( item )
	return item

def exportLevel( objects, name ):

	os.makedirs( BUILT, exist_ok = True )
	selectOnly( objects )
	path = os.path.join( BUILT, name + '.glb' )
	bpy.ops.export_scene.gltf(
		filepath = path, export_format = 'GLB', use_selection = True,
		export_vertex_color = 'ACTIVE', export_attributes = True, export_yup = True,
		export_image_format = 'AUTO', export_tangents = False,
	)
	print( f'导出 { path }：{ sum( triangleCount( item ) for item in objects ) } 三角' )

meshes = importKit()
placed = assemble( meshes )
if previewOnly:
	preview( placed )
else:
	castle, glass = joinAndSplit( placed )
	castleHeight = max( ( castle.matrix_world @ Vector( corner ) ).z for corner in castle.bound_box )
	print( f'城堡高 { castleHeight:.1f} 米' )
	# 先减到 40 万三角再烘 AO（一百多万三角烘太慢），三级再从它往下减
	decimate( castle, 400000 )
	bakeAmbientOcclusion( castle )
	roomList = labelWindows( glass, castleHeight )
	glassMaterial = glass.data.materials[ 0 ]
	# 三级：近处（高档）10 万、中档 2.5 万、远景替身 6 千三角；低的两级先删碎件
	levels = [ ( 'gothic-castle', 100000, 0, glass ), ( 'gothic-castle-lod1', 25000, 1.2, glass ) ]
	for name, target, minSize, windows in levels:
		copy = castle.copy()
		copy.data = castle.data.copy()
		bpy.context.scene.collection.objects.link( copy )
		copy.name = name + '·石头'
		if minSize > 0:
			dropSmallParts( copy, minSize )
		decimate( copy, target )
		copy.data.validate()
		exportLevel( [ copy, windows ], name )
	# 中档的碎件减面减不下去（每个独立小件都有最低面数），删掉 1.2 米以下的碎件以后大约 4.4 万三角，核显上也不算负担。
	# 远景替身用体素重建的外壳（0.6 米一格）减到 6 千三角，窗换成每间一块的方片
	shell = silhouetteShell( castle, 0.6, 6000 )
	exportLevel( [ shell, roomQuads( roomList, castleHeight, glassMaterial ) ], 'gothic-castle-lod2' )
